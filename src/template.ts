import type {TemplateContext} from './model.js';

export const renderTemplate = (template: string, context: TemplateContext): string =>
  template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    if (!(key in context)) {
      throw new Error(`Unknown template variable: ${key}`);
    }
    return context[key as keyof TemplateContext];
  });
