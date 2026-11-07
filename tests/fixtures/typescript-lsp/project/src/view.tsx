import { label } from './widget.js';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      section: { children?: unknown };
    }
  }
}

export const view = <section>{label()}</section>;
