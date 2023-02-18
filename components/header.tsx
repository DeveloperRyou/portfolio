import { NICKNAME } from '@lib/constants'
import Link from 'next/link'
import PortfolioContext from '@components/context'
import { useContext } from 'react'

const Header = () => {
  const { prefix } = useContext(PortfolioContext);
  return (
    <h2 className="text-2xl md:text-4xl font-bold tracking-tight md:tracking-tighter leading-tight mb-20 mt-8">
      <Link as={`${prefix}/`} href={`${prefix}/`} className="hover:underline">
        {NICKNAME}
      </Link>
      .
    </h2>
  )
}

export default Header
