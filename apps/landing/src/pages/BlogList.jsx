import { Link } from 'react-router-dom'
import { Calendar, User } from 'lucide-react'
import { posts } from '../content/blog'
import Header from '../components/Header'
import Footer from '../components/Footer'

export default function BlogList() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />
      <main className="flex-1 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 pt-32 w-full">
        <h1 className="text-3xl font-bold text-foreground mb-2">Blog</h1>
        <p className="text-muted-foreground mb-12">
          Neuigkeiten und Hintergründe zum Web-of-Trust Projekt.
        </p>

        <div className="space-y-8">
          {posts.map((post) => (
            <Link
              key={post.slug}
              to={`/blog/${post.slug}`}
              className="block group"
            >
              <article className="p-6 border border-border rounded-lg hover:border-primary/30 hover:bg-primary/5 transition-colors">
                <h2 className="text-xl font-semibold text-foreground group-hover:text-primary transition-colors mb-2">
                  {post.draft && <span className="inline-block text-xs font-medium bg-yellow-500/20 text-yellow-600 border border-yellow-500/30 rounded px-2 py-0.5 mr-2 align-middle">DRAFT</span>}
                  {post.title}
                </h2>
                <p className="text-muted-foreground mb-4">
                  {post.description}
                </p>
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Calendar size={14} />
                    {new Date(post.date).toLocaleDateString('de-DE', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <User size={14} />
                    {post.author}
                  </span>
                </div>
              </article>
            </Link>
          ))}
        </div>
      </main>
      <Footer />
    </div>
  )
}
