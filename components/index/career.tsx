import PortfolioContext from "@components/context";
import { useContext } from "react";
import Image from "next/image";
import CareerItem from "@components/index/career-item";

const Career = () => {
  const { prefix } = useContext(PortfolioContext);
  return (
    <div className="inline-block mt-16 mb-16 md:mb-12">
      <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold mb-8">
        Career
      </h1>
      <section className="flex-col md:flex-row flex items-center md:justify-between">
        <div className="text-center mb-8 md:mb-0 w-1/2 md:w-1/3 mx-auto md:mr-auto md:pr-8">
          <Image
            src={`${prefix}/assets/developerryou.jpg`}
            alt="career"
            className="rounded-full"
            width={1000}
            height={1000}
          />
        </div>
        <div className="text-left text-lg mt-auto mb-1 lg:pl-12 md:w-2/3">
          <div className="mb-2">
            <h2 className="text-2xl">
              <a
                className="hover:text-sky-600 underline decoration-sky-400"
                href="https://cs.yonsei.ac.kr/index.php"
                target="_blank"
              >
                Yonsei University
              </a>
              , Seoul
              <br />
              <div className="w-full text-right">
                <span className="text-xl">
                  - Currently enrolled in Bachelor of&nbsp;
                  <span className="underline">
                    Computer Science & Business Administration
                  </span>
                </span>
              </div>
            </h2>
            <p className="text-base text-gray-500">2018.2. ~ Present</p>
          </div>
          <hr className="border-1 border-black my-2" />
          <CareerItem
            title="42 Seoul"
            content="Member of 42 Seoul"
            startDate="2022.12."
            endDate="Present"
            link="https://github.com/developerryou-42seoul"
            underline
          />
          <CareerItem
            title="Eolluga"
            content="Development Team Leader"
            startDate="2023.6.21."
            endDate="Present"
          />
          <CareerItem
            title="OASIS"
            content="Development Team Leader"
            startDate="2022.9."
            endDate="Present"
            link="https://oasisbot24.com/"
          />
          <hr className="border-1 border-black my-2" />
          <CareerItem
            title="Hire Diversity"
            content="Frontend Developer"
            startDate="2023.6."
            endDate="2023.8."
            link="https://www.hirevisa.com/"
          />
          <CareerItem
            title="Stock Price Predict Model"
            content="LSTM Project Leader Programmer"
            startDate="2022.4."
            endDate="2022.6."
            link="https://github.com/DeveloperRyou/stockPricePredict_AI"
          />
          <CareerItem
            title="42 Seoul"
            content="Leaner"
            startDate="2022.2."
            endDate="2022.12."
            link="https://github.com/developerryou-42seoul"
          />
          <CareerItem
            title="World Curture Travel"
            content="Outsourced Mobile Application Project"
            startDate="2019.5."
            endDate="2019.7."
            link="https://play.google.com/store/apps/details?id=com.e.worldct&hl=en_CA"
          />
          <CareerItem
            title="Hanalum"
            content="Project Leader"
            startDate="2019.2."
            endDate="2020.5."
            link="http://hanalum.kr/"
          />
        </div>
      </section>
    </div>
  );
};

export default Career;
