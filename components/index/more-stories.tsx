import PostPreview from './post-preview'
import type Post from '@interfaces/post'

type Props = {
  posts: Post[]
}

const MoreStories = ({ posts }: Props) => {
  return (
    <div className='inline-block mt-16 mb-16 md:mb-12'>
      <h1 className="mb-8 text-5xl md:text-7xl font-bold tracking-tighter leading-tight">
        More
      </h1>
      <section>
        <div className="grid grid-cols-1 md:grid-cols-2 md:gap-x-16 lg:gap-x-32 gap-y-20 md:gap-y-32 mb-32">
          {posts.map((post) => (
            <PostPreview
              key={post.slug}
              title={post.title}
              coverImage={post.coverImage}
              date={post.date}
              slug={post.slug}
              excerpt={post.excerpt}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

export default MoreStories
