// <apiquity-ui>: the viewer as a web component, rendered in a shadow root with its own styles.
//
//   <script type="module" src="apiquity.js"></script>
//   <apiquity-ui openapi="openapi.json" asyncapi="asyncapi.yaml" routing="hash"></apiquity-ui>
//
// Attributes:
//   openapi, asyncapi  URLs of the documents (JSON or YAML); at least one.
//   routing            "hash": the selection is kept in the page's URL hash (deep links, back/forward).
//                      Otherwise (the default) it stays inside the component, leaving the page's hash alone.
// Styles:
//   --apiquity-ui-height  height of the split view (list + selected endpoint); default 100vh.
// Events:
//   load               once the documents are loaded; `detail.title` is the first document's title.
import { render } from "preact";
import { App, type Routing } from "./App.tsx";
import css from "./style.css?inline";

const ATTRIBUTES = ["openapi", "asyncapi", "routing"] as const;

export class ApiquityUi extends HTMLElement {
  static observedAttributes = ATTRIBUTES;
  #root: ShadowRoot;
  /** Where Preact renders: a node of its own, so that it leaves the <style> alone. */
  #mount: HTMLDivElement;
  #connected = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    this.#mount = document.createElement("div");
    this.#mount.className = "mount";
    this.#root.append(style, this.#mount);
  }

  connectedCallback() {
    this.#connected = true;
    this.#render();
  }

  disconnectedCallback() {
    this.#connected = false;
    render(null, this.#mount);
  }

  attributeChangedCallback() {
    if (this.#connected) this.#render();
  }

  #render() {
    const routing: Routing = this.getAttribute("routing") === "hash" ? "hash" : "none";
    render(
      <App
        openapi={this.getAttribute("openapi") ?? undefined}
        asyncapi={this.getAttribute("asyncapi") ?? undefined}
        routing={routing}
        root={this.#root}
        onLoad={(title) => this.dispatchEvent(new CustomEvent("load", { detail: { title } }))}
      />,
      this.#mount,
    );
  }
}

if (!customElements.get("apiquity-ui")) customElements.define("apiquity-ui", ApiquityUi);

declare global {
  interface HTMLElementTagNameMap {
    "apiquity-ui": ApiquityUi;
  }
}
