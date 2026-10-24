import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
if (typeof window !== 'undefined' && !window.global) window.global = window;
