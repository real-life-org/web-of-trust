import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Card, Button } from '@real-life/toolkit'
import { useLanguage } from '../i18n/LanguageContext'

function FAQItem({ question, answer, isOpen, onClick }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        className="w-full py-5 flex items-center justify-between text-left"
        onClick={onClick}
      >
        <span className="font-medium text-foreground pr-4">{question}</span>
        {isOpen ? (
          <ChevronUp className="shrink-0 text-primary" size={20} />
        ) : (
          <ChevronDown className="shrink-0 text-muted-foreground" size={20} />
        )}
      </button>
      {isOpen && (
        <div className="pb-5 pr-8">
          <p className="text-muted-foreground">{answer}</p>
        </div>
      )}
    </div>
  )
}

export default function FAQ() {
  const [openItems, setOpenItems] = useState({})
  const { t } = useLanguage()

  const toggleItem = (categoryIndex, questionIndex) => {
    const key = `${categoryIndex}-${questionIndex}`
    setOpenItems((prev) => ({
      ...prev,
      [key]: !prev[key],
    }))
  }

  return (
    <section id="faq" className="py-16 md:py-24 bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-4">
            {t.faq.title}
          </h2>
          <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            {t.faq.subtitle}
          </p>
        </div>

        {/* FAQ Categories */}
        <div className="max-w-3xl mx-auto">
          {t.faq.categories.map((category, categoryIndex) => (
            <div key={categoryIndex} className="mb-10 last:mb-0">
              <h3 className="text-sm font-semibold text-primary uppercase tracking-wider mb-4">
                {category.category}
              </h3>
              <Card className="px-6 gap-0">
                {category.questions.map((item, questionIndex) => (
                  <FAQItem
                    key={questionIndex}
                    question={item.q}
                    answer={item.a}
                    isOpen={openItems[`${categoryIndex}-${questionIndex}`]}
                    onClick={() => toggleItem(categoryIndex, questionIndex)}
                  />
                ))}
              </Card>
            </div>
          ))}
        </div>

        {/* More Questions */}
        <div className="mt-12 text-center">
          <p className="text-muted-foreground mb-4">
            {t.faq.moreQuestions}
          </p>
          <Button asChild variant="outline">
            <a
              href="https://github.com/antontranelis/web-of-trust-concept/issues"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.faq.askOnGithub}
            </a>
          </Button>
        </div>
      </div>
    </section>
  )
}
