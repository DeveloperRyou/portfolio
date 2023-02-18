import Head from 'next/head'
import { NICKNAME, HOME_OG_IMAGE_URL } from '@lib/constants'

const Meta = () => {
  return (
    <Head>
      <link
        rel="icon"
        type="image/png"
        sizes="50x50"
        href="/favicon/developerryou-50.png"
      />
      <link
        rel="icon"
        type="image/png"
        sizes="100x100"
        href="/favicon/developerryou-100.png"
      />
      <meta name="theme-color" content="#000" />
      <meta
        name="description"
        content={`Portfolio website of ${NICKNAME}.`}
      />
      <meta property="og:title" content={NICKNAME} />
      <meta property="og:description" content={`Portfolio website of ${NICKNAME}.`} />
      <meta property="og:image" content={HOME_OG_IMAGE_URL} />
    </Head>
  )
}

export default Meta
