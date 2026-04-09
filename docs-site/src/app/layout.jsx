import { Footer, Layout, Navbar } from 'nextra-theme-docs';
import { Head } from 'nextra/components';
import { getPageMap } from 'nextra/page-map';
import 'nextra-theme-docs/style.css';

export const metadata = {
  title: 'protoWorkstacean Docs',
  description:
    'Documentation for protoWorkstacean — homeostatic agent orchestration platform.',
};

const navbar = <Navbar logo={<b>protoWorkstacean</b>} />;
const footer = (
  <Footer>MIT {new Date().getFullYear()} © protoLabsAI.</Footer>
);

export default async function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/protoLabsAI/protoWorkstacean/tree/main/docs"
          sidebar={{ defaultMenuCollapseLevel: 9999 }}
          footer={footer}
          search={false}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
