export type ValueOf<T> = T[keyof T];

/** The formats a chat is exported in: the background makes the file, the side panel offers them */
export type ExportFormat = 'debug' | 'log' | 'txt' | 'md' | 'html' | 'pdf';

/** A chat exported as a file for the side panel to save: text as it is, a PDF as base64 */
export interface ExportedFile {
  filename: string;
  mime: string;
  data: string;
  base64?: boolean;
}
