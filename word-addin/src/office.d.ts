// Minimal ambient declarations for the slice of the Office.js / Word API this
// add-in uses. Avoids a heavyweight @types/office-js dependency; install that
// package for full IntelliSense if you extend the Word integration.

declare namespace Office {
  function onReady(handler?: (info: { host: unknown; platform: unknown }) => void): Promise<{ host: unknown; platform: unknown }>;
}

declare namespace Word {
  function run<T>(batch: (context: RequestContext) => Promise<T>): Promise<T>;

  interface RequestContext {
    document: Document;
    sync(): Promise<void>;
  }
  interface Document {
    body: Body;
    getSelection(): Range;
  }
  interface Body {
    text: string;
    load(props?: string): void;
    insertText(text: string, location: InsertLocation): Range;
  }
  interface Range {
    text: string;
    load(props?: string): void;
    insertText(text: string, location: InsertLocation): Range;
  }
  // Office.js accepts these enum values as plain capitalized strings.
  type InsertLocation = 'Replace' | 'Start' | 'End' | 'Before' | 'After';
}
