import Link from 'next/link'
import Container from './container'
import { GITHUB_PATH, NICKNAME } from '@lib/constants'

const Footer = () => {
  return (
    <footer className="bg-neutral-50 border-t border-neutral-200">
      <Container>
        <div className="py-28 flex flex-col lg:flex-row items-center">
          <h3 className="text-4xl lg:text-[2.5rem] font-bold tracking-tighter leading-tight text-center lg:text-left mb-10 lg:mb-0 lg:pr-4 lg:w-1/2">
            {NICKNAME}
          </h3>
          <div className="flex flex-col lg:flex-row justify-center items-center lg:justify-end lg:pl-4 lg:w-1/2">
            <Link
              href="./assets/resume.pdf"
              target='_blank'
              className="mx-3 bg-black hover:bg-white hover:text-black border border-black text-white font-bold py-3 px-12 lg:px-8 duration-200 transition-colors mb-6 lg:mb-0"
            >
              Download Resume
            </Link>
            <a
              href={GITHUB_PATH}
              target='_blank'
              className="mx-3 font-bold hover:underline"
            >
              Visit GitHub
            </a>
          </div>
        </div>
      </Container>
    </footer>
  )
}

export default Footer
