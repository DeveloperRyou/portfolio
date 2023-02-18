import Head from 'next/head'
import Container from '@components/container'
import Layout from '@components/layout'
import Intro from '@components/index/intro'
import MoreStories from '@components/index/more-stories'
import HeroPost from '@components/index/hero-post'
import { getAllPosts } from '@lib/api'
import { NICKNAME } from '@lib/constants'
import Post from '@interfaces/post'
import Career from '@components/index/career'

type Props = {
  allPosts: Post[]
}

export default function Index({ allPosts }: Props) {
  const heroPost = allPosts[0]
  const morePosts = allPosts.slice(1)
  return (
    <>
      <Layout>
        <Head>
          <title>{NICKNAME}</title>
        </Head>
        <Container>
          <Intro />
          <Career />
          {heroPost && (
            <HeroPost
              title={heroPost.title}
              coverImage={heroPost.coverImage}
              date={heroPost.date}
              slug={heroPost.slug}
              excerpt={heroPost.excerpt}
            />
          )}
          {morePosts.length > 0 && <MoreStories posts={morePosts} />}
        </Container>
      </Layout>
    </>
  )
}

export const getStaticProps = async () => {
  const allPosts = getAllPosts([
    'title',
    'date',
    'slug',
    'author',
    'coverImage',
    'excerpt',
  ])

  return {
    props: { allPosts },
  }
}
