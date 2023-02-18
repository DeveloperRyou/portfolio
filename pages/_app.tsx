import { AppProps } from 'next/app'
import '../styles/index.css'
import PortfolioContext from '@components/context'
import { prefix } from "../config/config";


export default function MyApp({ Component, pageProps }: AppProps) {
  return (
    <PortfolioContext.Provider value={{ prefix }}>
      <Component {...pageProps} />
    </PortfolioContext.Provider>
  );
}
