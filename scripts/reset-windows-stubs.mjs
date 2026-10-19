import { resolve as resolveGi, STUB_URL } from './gi-stub-hooks.mjs';

// Use the real forest and pile implementations with only Shell/GI boundaries stubbed.
export function resolve(specifier, context, next) {
    if (specifier === './window.js' && context.parentURL.includes('/target/')) {
        return { url: 'data:text/javascript,export class ShellWindow {}', shortCircuit: true };
    }
    if (specifier === 'resource:///org/gnome/shell/ui/main.js') return { url: STUB_URL, shortCircuit: true };
    return resolveGi(specifier, context, next);
}
