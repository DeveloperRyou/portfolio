import PortfolioContext from '@components/context'
import { useContext } from 'react'
import Image from 'next/image'

const Career = () => {
  const { prefix } = useContext(PortfolioContext);
  return (
    <div className='inline-block mt-16 mb-16 md:mb-12'>
      <h1 className='text-3xl md:text-4xl lg:text-5xl font-bold mb-8'>Career</h1>
      <section className="flex-col md:flex-row flex items-center md:justify-between">
        <div className="text-center mb-8 md:mb-0 w-1/2 md:w-1/3 mx-auto md:mr-auto md:pr-8">
          <Image 
            src={`${prefix}/assets/developerryou.jpg`}
            alt="career"
            className='rounded-full'
            width={1000}
            height={1000}
          />
        </div>
        <div className="text-left text-lg mt-auto mb-1 lg:pl-12 md:w-2/3">
          <div className='mb-2'>
            <h2 className='text-2xl'>
              <a className='hover:text-sky-600 underline decoration-sky-400'
              href='https://cs.yonsei.ac.kr/index.php'
              target='_blank'>
                Yonsei University
              </a>
              , Seoul
              <span className='text-xl'>&nbsp;- Bachelor of Computer Science</span>
            </h2>
            <p className='text-base text-gray-500'>2018.2. ~</p>
          </div>
          <div className='mb-2'>
            <h2 className='text-2xl'>
              <a className='hover:text-sky-600'
              href='http://hanalum.kr/'
              target='_blank'>
                Hanalum
              </a>
              <span className='text-xl'>&nbsp;- Project Leader</span>
            </h2>
            <p className='text-base text-gray-500'>2019.2. ~ 2020.5.</p>
          </div>
          <div className='mb-2'>
            <h2 className='text-2xl'>
              <a className='hover:text-sky-600'
              href='https://play.google.com/store/apps/details?id=com.e.worldct&hl=en_CA'
              target='_blank'>
                World Curture Travel
              </a>
              <span className='text-xl'>&nbsp;- Outsourced Mobile Application Project</span>
            </h2>
            <p className='text-base text-gray-500'>2019.5. ~ 2019.7.</p>
          </div>
          <div className='mb-2'>
            <h2 className='text-2xl'>
              <a className='hover:text-sky-600 underline decoration-sky-400'
              href='https://42seoul.kr/seoul42/main/view'
              target='_blank'>
                42 Seoul
              </a>
              <span className='text-xl'>&nbsp;- Learner</span>
            </h2>
            <p className='text-base text-gray-500'>2022.2. ~</p>
          </div>
          <div className='mb-2'>
            <h2 className='text-2xl'>
              <a className='hover:text-sky-600'
              href='https://github.com/DeveloperRyou/stockPricePredict_AI'
              target='_blank'>
                Stock Price Predict Model
              </a>
              <span className='text-xl'>&nbsp;- LSTM Project Leader Programmer</span>
            </h2>
            <p className='text-base text-gray-500'>2022.4. ~ 2022.6.</p>
          </div>
          <div>
            <h2 className='text-2xl'>
              <a className='hover:text-sky-600'
              href='https://oasisbot24.com/'
              target='_blank'>
                OASIS
              </a>
              <span className='text-xl'>&nbsp;- Development Team Leader</span>
            </h2>
            <p className='text-base text-gray-500'>2022.9. ~</p>
          </div>
        </div>
      </section>
    </div>
  )
}

export default Career
