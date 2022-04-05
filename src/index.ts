interface Definition {
    LatestCtor: CustomElementConstructor;
    PivotCtor?: CustomElementConstructor;
    connectedCallback: (() => void) | void;
    disconnectedCallback: (() => void) | void;
    adoptedCallback: (() => void) | void;
    attributeChangedCallback: ((name: string, oldValue: any, newValue: any) => void) | void;
    formAssociatedCallback: (() => void) | void;
    formDisabledCallback: (() => void) | void;
    formResetCallback: (() => void) | void;
    formStateRestoreCallback: (() => void) | void;
    observedAttributes: Set<string>;
}

const cer = customElements;
const NativeHTMLElement = HTMLElement;

const {
    hasAttribute: nativeHasAttribute,
    setAttribute: nativeSetAttribute,
    removeAttribute: nativeRemoveAttribute,
    getAttribute: nativeGetAttribute,
} = NativeHTMLElement.prototype;

const { apply: ReflectApply, setPrototypeOf: ReflectSetPrototypeOf, construct: ReflectConstruct } = Reflect;
const { defineProperties: ObjectDefineProperties } = Object;

const {
    get: nativeGet,
    define: nativeDefine,
    whenDefined: nativeWhenDefined,
} = CustomElementRegistry.prototype;

const nativeNodeIsConnectedGetter = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected')!.get!;

function valueToString(value: any): string {
    try {
        return String(value);
        // eslint-disable-next-line no-empty
    } catch {}
    return '';
}

function createDefinitionRecord(constructor: CustomElementConstructor): Definition {
    // Since observedAttributes can't change, we approximate it by patching
    // set/removeAttribute on the user's class
    const {
        connectedCallback,
        disconnectedCallback,
        adoptedCallback,
        attributeChangedCallback,
        formAssociatedCallback,
        formDisabledCallback,
        formResetCallback,
        formStateRestoreCallback,
    } = constructor.prototype;
    const observedAttributes = new Set<string>((constructor as any).observedAttributes || []);
    return {
        LatestCtor: constructor,
        connectedCallback,
        disconnectedCallback,
        adoptedCallback,
        formAssociatedCallback,
        formDisabledCallback,
        formResetCallback,
        formStateRestoreCallback,
        attributeChangedCallback,
        observedAttributes,
    };
}

function getObservedAttributesOffset(originalDefinition: Definition, instancedDefinition: Definition) {
    // natively, the attributes observed by the registered definition are going to be taken
    // care of by the browser, only the difference between the two sets has to be taken
    // care by the patched version.
    return new Set(
        [...originalDefinition.observedAttributes].filter(
            (x) => !instancedDefinition.observedAttributes.has(x)
        )
    );
}

// Helper to patch CE class setAttribute/getAttribute to implement
// attributeChangedCallback
function patchAttributes(
    instance: HTMLElement,
    originalDefinition: Definition,
    instancedDefinition: Definition
) {
    const { observedAttributes, attributeChangedCallback } = instancedDefinition;
    if (observedAttributes.size === 0 || !attributeChangedCallback) {
        return;
    }
    const offset = getObservedAttributesOffset(originalDefinition, instancedDefinition);
    if (offset.size === 0) {
        return;
    }
    // instance level patches
    ObjectDefineProperties(instance, {
        setAttribute: {
            value: function setAttribute(name: string, value: any) {
                if (offset.has(name)) {
                    const old = nativeGetAttribute.call(this, name);
                    // maybe we want to call the super.setAttribute rather than the native one
                    nativeSetAttribute.call(this, name, value);
                    attributeChangedCallback.call(this, name, old, valueToString(value));
                } else {
                    nativeSetAttribute.call(this, name, value);
                }
            },
            writable: true,
            enumerable: true,
            configurable: true,
        },
        removeAttribute: {
            value: function removeAttribute(name: string) {
                if (offset.has(name)) {
                    const old = nativeGetAttribute.call(this, name);
                    // maybe we want to call the super.removeAttribute rather than the native one
                    nativeRemoveAttribute.call(this, name);
                    attributeChangedCallback.call(this, name, old, null);
                } else {
                    nativeRemoveAttribute.call(this, name);
                }
            },
            writable: true,
            enumerable: true,
            configurable: true,
        },
    });
}

// Helper to create stand-in element for each tagName registered that delegates
// out to the internal registry for the given element
function createPivotingClass(originalDefinition: Definition, tagName: string) {
    return class PivotCtor extends NativeHTMLElement {
        constructor(definition?: Definition, args?: any[]) {
            // This constructor can only be invoked by:
            // a) the browser instantiating  an element from parsing or via document.createElement.
            // b) new UserClass.
            super();

            // b) user's initiated instantiation via new Ctor() in a sandbox
            if (definition) {
                internalUpgrade(this, originalDefinition, definition, args);
                return this;
            }

            // a) browser's initiated instantiation.
            if (!ReflectApply(nativeNodeIsConnectedGetter, this, [])) {
                // TODO: I'm not sure yet how is this going to be possible, but
                // seems very odd that someone is creating an instance without
                // doing new on the constructor, and without the element be
                // connected to the DOM.
                throw new TypeError('Illegal invocation');
            }

            // Schedule or upgrade instance
            definition = definitionsByTag.get(tagName);
            if (definition) {
                // browser's initiated a controlled instantiation where we
                // were able to set up the internal registry and the definition.
                internalUpgrade(this, originalDefinition, definition);
            } else {
                // This is the case in which there is no definition yet, and
                // we need to add it to the pending queue just in case it eventually
                // gets defined locally.
                pendingRegistryForElement.set(this, originalDefinition);
                // We need to install the minimum HTMLElement prototype so that
                // this instance works like a regular element without a registered
                // definition; #internalUpgrade will eventually install the full CE prototype
                ReflectSetPrototypeOf(this, patchedHTMLElement.prototype);
            }
        }
        connectedCallback() {
            const definition = definitionForElement.get(this);
            if (definition) {
                // Delegate out to user callback
                definition.connectedCallback?.call(this);
            } else {
                // Register for upgrade when defined (only when connected, so we don't leak)
                let awaiting = awaitingUpgrade.get(tagName);
                if (!awaiting) {
                    awaitingUpgrade.set(tagName, (awaiting = new Set()));
                }
                awaiting.add(this);
            }
        }
        disconnectedCallback() {
            const definition = definitionForElement.get(this);
            if (definition) {
                // Delegate out to user callback
                definition.disconnectedCallback?.call(this);
            } else {
                // Un-register for upgrade when defined (so we don't leak)
                const awaiting = awaitingUpgrade.get(tagName);
                if (awaiting) {
                    awaiting.delete(this);
                }
            }
        }
        adoptedCallback() {
            // TODO: this needs more work
            const definition = definitionForElement.get(this);
            definition?.adoptedCallback?.call(this);
        }
        formAssociatedCallback() {
            const definition = definitionForElement.get(this);
            definition?.formAssociatedCallback?.apply(this, arguments);
        }
        formDisabledCallback() {
            const definition = definitionForElement.get(this);
            definition?.formDisabledCallback?.apply(this, arguments);
        }
        formResetCallback() {
            const definition = definitionForElement.get(this);
            definition?.formResetCallback?.apply(this, arguments);
        }
        formStateRestoreCallback() {
            const definition = definitionForElement.get(this);
            definition?.formStateRestoreCallback?.apply(this, arguments);
        }
        attributeChangedCallback(...args: [name: string, oldValue: any, newValue: any]) {
            const definition = definitionForElement.get(this);
            // if both definitions are the same, then the observedAttributes is the same,
            // but if they are different, only if the runtime definition has the attribute
            // marked as observed, then it should invoke attributeChangedCallback.
            if (originalDefinition === definition || definition?.observedAttributes.has(args[0])) {
                definition.attributeChangedCallback?.apply(this, args);
            }
        }

        static observedAttributes = originalDefinition.observedAttributes;
    };
}

let upgradingInstance: HTMLElement | undefined;
const definitionForElement = new WeakMap<HTMLElement, Definition>();
const pendingRegistryForElement = new WeakMap<HTMLElement, Definition>();
const definitionForConstructor = new WeakMap<CustomElementConstructor, Definition>();
const pivotCtorByTag = new Map<string, CustomElementConstructor>();
const definitionsByTag = new Map<string, Definition>();
const definitionsByClass = new Map<CustomElementConstructor, Definition>();
const definedPromises = new Map<string, Promise<CustomElementConstructor>>();
const definedResolvers = new Map<string, (ctor: CustomElementConstructor) => void>();
const awaitingUpgrade = new Map<string, Set<HTMLElement>>();

// Helper to upgrade an instance with a CE definition using "constructor call trick"
function internalUpgrade(
    instance: HTMLElement,
    originalDefinition: Definition,
    instancedDefinition: Definition,
    args?: any[]
) {
    ReflectSetPrototypeOf(instance, instancedDefinition.LatestCtor.prototype);
    definitionForElement.set(instance, instancedDefinition);
    // attributes patches when needed
    if (instancedDefinition !== originalDefinition) {
        patchAttributes(instance, originalDefinition, instancedDefinition);
    }
    // Tricking the construction path to believe that a new instance is being created,
    // that way it will execute the super initialization mechanism but the HTMLElement
    // constructor will reuse the instance by returning the upgradingInstance.
    // This is by far the most important piece of the puzzle
    upgradingInstance = instance;
    // TODO: do we need to provide a newTarget here as well? if yes, what should that be?
    ReflectConstruct(instancedDefinition.LatestCtor, args || []);

    const { observedAttributes, attributeChangedCallback } = instancedDefinition;
    if (observedAttributes.size > 0 && attributeChangedCallback) {
        const offset = getObservedAttributesOffset(originalDefinition, instancedDefinition);
        if (offset.size > 0) {
            // Approximate observedAttributes from the user class, but only for the offset attributes
            offset.forEach((name) => {
                if (nativeHasAttribute.call(instance, name)) {
                    const newValue = nativeGetAttribute.call(instance, name);
                    attributeChangedCallback.call(instance, name, null, newValue);
                }
            });
        }
    }

    // connectedCallback retroactively invocation
    // TODO: I'm not sure this is really needed...
    if (ReflectApply(nativeNodeIsConnectedGetter, instance, [])) {
        instancedDefinition.disconnectedCallback?.call(instance);
    }
}

function getDefinitionForConstructor(constructor: CustomElementConstructor): Definition {
    if (!constructor || !constructor.prototype || typeof constructor.prototype !== 'object') {
        throw new TypeError(`The referenced constructor is not a constructor.`);
    }
    let definition = definitionForConstructor.get(constructor);
    if (!definition) {
        definition = createDefinitionRecord(constructor);
        definitionForConstructor.set(constructor, definition);
    }
    return definition;
}

const patchedHTMLElement = function HTMLElement(this: HTMLElement, ...args: any[]) {
    if (!new.target) {
        throw new TypeError(
            `Failed to construct 'HTMLElement': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`
        );
    }
    if (new.target === patchedHTMLElement) {
        throw new TypeError(`Illegal constructor`);
    }
    // This constructor is ONLY invoked when it is the user instantiating
    // an element via `new Ctor()` while `this.constructor` is a locally
    // registered constructor, otherwise it throws.
    // Upgrading case: the pivoting class constructor was run by the browser's
    // native custom elements and we're in the process of running the
    // "constructor-call trick" on the natively constructed instance, so just
    // return that here
    const pendingUpgradeInstance = upgradingInstance;
    if (pendingUpgradeInstance) {
        upgradingInstance = undefined;
        return pendingUpgradeInstance;
    }
    const { constructor } = this;
    // Construction case: we need to construct the pivoting instance and return it
    // This is possible when the user instantiate it via `new LatestCtor()`.
    const definition = definitionsByClass.get(constructor as CustomElementConstructor);
    if (!definition || !definition.PivotCtor) {
        throw new TypeError('Illegal constructor');
    }
    // This constructor is ONLY invoked when it is the user instantiating
    // an element via new Ctor while Ctor is the latest registered constructor.
    return new definition.PivotCtor(definition, args);
}
patchedHTMLElement.prototype = NativeHTMLElement.prototype;

// patching global registry associated to the global object
Object.assign(CustomElementRegistry.prototype, {
    get(
        this: CustomElementRegistry,
        ...args: Parameters<typeof customElements.get>
    ): ReturnType<typeof customElements.get> {
        if (this !== cer) {
            // This is more restricted than native behavior because in native this is
            // going to leak constructors from another windows. But right now, I don't
            // know the implications yet, the safe bet is to throw here.
            // TODO: this could leak pivots from another document, that's the concern.
            throw new TypeError('Illegal invocation');
        }
        const { 0: tagName } = args;
        return (
            // SyntaxError if The provided name is not a valid custom element name.
            ReflectApply(nativeGet, this, args) &&
            definitionsByTag.get(tagName)?.LatestCtor
        );
    },
    define(
        this: CustomElementRegistry,
        ...args: Parameters<typeof customElements.define>
    ): ReturnType<typeof customElements.define> {
        if (this !== cer) {
            // This is more restricted than native behavior because in native this is
            // normally a runtime error when attempting to define a class that inherit
            // from a constructor from another window. But right now, I don't know how
            // to do this runtime check, the safe bet is to throw here.
            throw new TypeError('Illegal invocation');
        }
        const { 0: tagName, 1: constructor, 2: options } = args;
        // TODO: I think we can support this just fine...
        if (options && options.extends) {
            // eslint-disable-next-line @typescript-eslint/no-throw-literal
            throw new DOMException('NotSupportedError: ');
        }
        let PivotCtor = ReflectApply(nativeGet, this, [tagName]); // SyntaxError if The provided name is not a valid custom element name.
        // TODO: do we really need to lower case this?
        // tagName = tagName.toLowerCase();
        if (PivotCtor && PivotCtor !== definitionsByTag.get(tagName)?.PivotCtor) {
            // This is just in case that there is something defined that is not a controlled pivot
            // eslint-disable-next-line @typescript-eslint/no-throw-literal
            throw new DOMException(
                `Failed to execute 'define' on 'CustomElementRegistry': the name "${tagName}" has already been used with this registry`
            );
        }
        const definition = getDefinitionForConstructor(constructor);
        if (definitionsByClass.get(constructor)) {
            // eslint-disable-next-line @typescript-eslint/no-throw-literal
            throw new DOMException(
                `Failed to execute 'define' on 'CustomElementRegistry': this constructor has already been used with this registry`
            );
        }
        definitionsByTag.set(tagName, definition);
        definitionsByClass.set(constructor, definition);
        PivotCtor = pivotCtorByTag.get(tagName);
        if (!PivotCtor) {
            PivotCtor = createPivotingClass(
                definition,
                tagName
            );
            pivotCtorByTag.set(tagName, PivotCtor);
            // Register a pivoting class which will handle global registry initializations
            ReflectApply(nativeDefine, this, [tagName, PivotCtor]);
        }
        // For globally defined custom elements, the definition associated
        // to the UserCtor has a back-pointer to PivotCtor in case the user
        // new the UserCtor, so we know how to create the underlying element.
        definition.PivotCtor = PivotCtor;
        // Upgrade any elements created in this scope before define was called
        // which should be exhibit by LWC using a tagName (in a template)
        // before the same tagName is registered as a global, while others
        // are already created and waiting in the global context, that will
        // require immediate upgrade when the new global tagName is defined.
        const awaiting = awaitingUpgrade.get(tagName);
        if (awaiting) {
            awaitingUpgrade.delete(tagName);
            awaiting.forEach((element) => {
                const originalDefinition = pendingRegistryForElement.get(element);
                if (originalDefinition) {
                    pendingRegistryForElement.delete(element);
                    internalUpgrade(element, originalDefinition, definition);
                }
            });
        }
        // Flush whenDefined callbacks
        const resolver = definedResolvers.get(tagName);
        if (resolver) {
            resolver(constructor);
        }
    },
    whenDefined(
        this: CustomElementRegistry,
        ...args: Parameters<typeof customElements.whenDefined>
    ): ReturnType<typeof customElements.whenDefined> {
        if (this !== cer) {
            // This is more restricted than native behavior because in native this is
            // going to leak constructors from another windows when defined. But right
            // now, I don't know the implications yet, the safe bet is to throw here.
            // TODO: maybe returning a promise that will never fulfill is better.
            throw new TypeError('Illegal invocation');
        }
        const { 0: tagName } = args;
        // TODO: the promise constructor could be leaked here when using multi-window
        // we probably need to do something here to return the proper type of promise
        // we need more investigation here.
        return ReflectApply(nativeWhenDefined, this, args).then(() => {
            let promise = definedPromises.get(tagName);
            if (!promise) {
                const definition = definitionsByTag.get(tagName);
                if (definition) {
                    return Promise.resolve(definition.LatestCtor);
                }
                let resolve: (constructor: CustomElementConstructor) => void;
                promise = new Promise((r) => {
                    resolve = r;
                });
                definedPromises.set(tagName, promise);
                definedResolvers.set(tagName, resolve!);
            }
            return promise;
        });
    },
    constructor: patchedHTMLElement,
});

// patching HTMLElement constructor associated to the global object
// @ts-ignore
window.HTMLElement = patchedHTMLElement;
