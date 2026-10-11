/** `import x from './file.py' with { type: 'text' }` inlines the file as a string. */
declare module '*.py' {
  const text: string;
  export default text;
}
