import Link from 'next/link'
import DateFormatter from '@components/posts/date-formatter'
import CoverImage from '@components/posts/cover-image'

type Props = {
  title: string
  coverImage: string
  date: string
  excerpt: string
  slug: string
}

const HeroPost = ({
  title,
  coverImage,
  date,
  excerpt,
  slug,
}: Props) => {
  return (
    <div className='inline-block mt-16 mb-16 md:mb-12'>
      <h1 className='mb-8 text-5xl md:text-7xl font-bold tracking-tighter leading-tight'>Project</h1>
      <section>
        <div className="mb-8 md:mb-16">
          <CoverImage title={title} src={coverImage} slug={slug} />
        </div>
        <div className="md:grid md:grid-cols-2 md:gap-x-16 lg:gap-x-8">
          <div>
            <h3 className="mb-4 text-4xl lg:text-5xl leading-tight">
              <Link
                as={`./posts/${slug}`}
                href="./posts/[slug]"
                className="hover:underline"
              >
                {title}
              </Link>
            </h3>
            <div className="mb-4 md:mb-0 text-lg">
              <DateFormatter dateString={date} />
            </div>
          </div>
          <div>
            <p className="text-lg leading-relaxed">{excerpt}</p>
          </div>
        </div>
      </section>
    </div>
  )
}

export default HeroPost
