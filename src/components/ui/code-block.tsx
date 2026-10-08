import * as React from "react";

import { cn } from "@/lib/utils";

interface CodeBlockProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** The literal code sample. Rendered as text, never as markup. */
  code: string;
  /** Language or content label for assistive tech (e.g. "bash", "json"). */
  lang?: string;
}

/**
 * Code sample surface for docs pages. Scrolls horizontally on narrow screens
 * and is focusable so keyboard users can scroll it.
 */
function CodeBlock({ code, lang, className, ...props }: CodeBlockProps) {
  return (
    <div
      data-slot="code-block"
      className={cn("mt-4 tortoise", className)}
      {...props}
    >
      <pre
        tabIndex={0}
        aria-label={lang ? `${lang} code sample` : "Code sample"}
        className="overflow-x-auto text-base"
      >
        <code className="font-mono text-text-primary">{code}</code>
      </pre>
    </div>
  );
}

export { CodeBlock, type CodeBlockProps };
