import { ChevronDown } from "lucide-react";
import { FAQ_ITEMS } from "./FAQ";

/**
 * The FAQ as plain markup, for a page that is prerendered and ships no
 * framework: the same questions and answers as `FAQ`, each question a heading
 * with a button inside it and the answer after it. The page hides the answers
 * and makes them `hidden="until-found"` once its script runs (a value React
 * cannot render), so find-in-page still reaches them.
 *
 * The buttons are wired by a few lines of script on the page (see
 * astro/src/pages/help.astro); with no script the answers are in the HTML and
 * a `<noscript>` style there shows them all. A custom accordion rather than
 * `<details>` because each question needs its own heading (modern-web-guidance
 * "accordion": JAWS and TalkBack drop a heading inside `summary`).
 */
export function FaqStatic() {
  return (
    <div data-faq className="w-full">
      {FAQ_ITEMS.map((item) => (
        <div
          key={item.value}
          data-slot="accordion-item"
          className="border-b border-text-tertiary/10"
        >
          <h3 className="flex">
            <button
              type="button"
              data-faq-trigger
              aria-expanded="false"
              aria-controls={`faq-${item.value}`}
              className="flex flex-1 cursor-pointer items-center justify-between py-4 text-left font-semibold text-text-primary transition-colors hover:text-primary focus-visible:rounded-[var(--radius-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&[aria-expanded=true]>svg]:rotate-180"
            >
              {item.question}
              <ChevronDown
                className="ml-2 h-4 w-4 shrink-0 text-text-tertiary transition-transform duration-200"
                aria-hidden="true"
              />
            </button>
          </h3>
          <div id={`faq-${item.value}`} data-faq-panel>
            <div className="pb-4 text-text-secondary leading-relaxed">
              {item.answer}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
