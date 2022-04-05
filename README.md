# Redefine Custom Elements

This experimental library patches the global custom elements registry to allow re-defining a custom element. Based on the spec, a custom element can be defined for a qualifying name only once, the class itself cannot be reused for a different name as well. These two restrictions often pushes developers away from using custom elements, or even supporting custom elements in their platforms, specifically, any framework that allows live refresh of the code without reloading the page will eventually encounter that these restrictions will prevent this from happening.

## Goal

* To allow redefinition of a custom element via `customElements.define()` API.

## Usage

Just import the library to patch the registry:

```js
import "redefine-custom-elements";
customElements.define('x-foo', class Foo extends HTMLElement {});
customElements.define('x-foo', class Bar extends HTMLElement {});
```

## Design

The concept of a pivot constructor is well proven now, it is used by the [scoped custom elements registry polyfill](https://github.com/webcomponents/polyfills/tree/master/packages/scoped-custom-element-registry/) as well, which inspire many parts of this library. This library relies on this concept to install a pivotal constructor into the custom elements registry, and whenever that pivot constructor is called by the engine, a corresponding (user-defined) constructor can be used to construct the final version of the instance before handing that over to user-land. To achieve this, we need to patch various methods of the `CustomElementRegistry.prototype`, and the `HTMLElement` constructor.

## Performance

This library is intended to be used during the development. Nevertheless, when patching DOM APIs, you're often going to get performance degradation, and this library is not the exception. The good news is that it doesn't affect, in any way, the element after it is created. The main concern in terms of performance will be the time to create an instance.

## Side effects

These patches are meant to be transparent, and should not be observed by user-land code, but this is hard to achieve when it comes to the DOM APIs. Execute this code first to avoid mismatches.

## Limitations

1. Any custom element defined before this library runs will not be replaceable. In this case, it will simply throw the built-in error.
2. If you rely on options when defining a custom element (e.g.: `customElements.define(name, constructor, options)`), non-equivalent options when redefining the element will not be recognized.
3. If it unclear how this can work with scoped custom elements, if that proposal moves forward.

## Browsers Support and Stats

* Modern browsers with support for custom elements.
* This library: <2kb gzip/minify (no external dependencies).
