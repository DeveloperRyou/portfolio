import { GITHUB_PATH, NICKNAME } from '@lib/constants'

const Intro = () => {
  return (
    <div className='inline-block mt-16 mb-16 md:mb-12 w-full'>
      <section className="flex-col lg:flex-row flex items-center md:justify-between">
        <div className='tracking-tighter leading-tight mb-4 lg:mb-0 lg:pr-8'>
          <h1 className="text-center lg:text-left text-5xl lg:text-7xl font-bold">
            {NICKNAME}
          </h1>
          <h4 className="text-center lg:text-left text-lg">
            Software engineer specialized in building web service.
          </h4>
        </div>
        <div className='mt-auto mb-1 lg:pl-8 text-center lg:text-left'>
          <h4>(+82) 10-4949-0297</h4>
          <h4>developerryou@gmail.com</h4>
          <h4><a href={GITHUB_PATH} target='_blank' className='underline decoration-sky-400 hover:decoration-2'>
            github.com/DeveloperRyou
          </a></h4>
        </div>
      </section>
    </div>
  )
}

export default Intro
