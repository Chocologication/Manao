import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './AssistantMarkdown.css';

export function AssistantMarkdown({ text }: { text: string }) {
  return <div className="ai-markdown min-w-0 break-words">
    <Markdown remarkPlugins={[remarkGfm]} components={{
      table: ({ children }) => <div className="ai-markdown-table"><table>{children}</table></div>,
    }}>{text}</Markdown>
  </div>;
}
