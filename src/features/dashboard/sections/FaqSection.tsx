// ============================================================
// FAQ — honest answers about where data goes
// ============================================================
// Native <details>/<summary>: keyboard accessible, searchable by the
// browser's find-in-page, and zero JavaScript.

import { FAQ_ITEMS } from "../tools";

export function FaqSection() {
  return (
    <section className="dash-faq" aria-labelledby="dash-faq-title">
      <h2 className="dash-section-title" id="dash-faq-title">
        How it works
      </h2>

      <div className="dash-faq-list">
        {FAQ_ITEMS.map((item) => (
          <details key={item.question} className="dash-faq-item">
            <summary className="dash-faq-question">{item.question}</summary>
            <p className="dash-faq-answer">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
