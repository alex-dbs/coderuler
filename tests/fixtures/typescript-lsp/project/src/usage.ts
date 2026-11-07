import { Widget, type Builder } from './widget.js';
import { external } from '../../project-dependency/index.js';

export const widget = new Widget();
export function run(): string {
  return widget.build();
}
export const builder: Builder = widget;
export const externalValue = external();
