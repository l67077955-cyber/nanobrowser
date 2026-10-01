import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** The agent's prose: lists, links, tables and code as written. Raw HTML in it is shown as text, never run. */
export default memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="nb-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: label }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          ),
          table: ({ children: rows }) => (
            <div className="nb-table">
              <table>{rows}</table>
            </div>
          ),
        }}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
