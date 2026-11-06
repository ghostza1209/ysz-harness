import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const GFM = [remarkGfm];
// A link opens a new tab and sends no Referer: the Dashboard's URL carries its token.
const LINKS: Components = { a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> };
// Opening a Ticket fetches nothing an agent named.
const NO_IMAGES = ['img'];

/**
 * Agent-written Markdown, GitHub-flavoured. Never HTML: react-markdown's defaults keep raw HTML as literal text and
 * drop unsafe link URLs (javascript: and the like), so keep rehype-raw and a custom urlTransform out.
 */
export const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="bl-md">
      <Markdown remarkPlugins={GFM} components={LINKS} disallowedElements={NO_IMAGES}>
        {text}
      </Markdown>
    </div>
  );
});
