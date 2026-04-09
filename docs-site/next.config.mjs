import nextra from 'nextra';

const withNextra = nextra({});

// When deploying to GitHub Pages at /protoWorkstacean, set basePath.
// Remove or override BASE_PATH if using a custom domain at the root.
const basePath = process.env.BASE_PATH ?? '/protoWorkstacean';

export default withNextra({
  output: 'export',
  basePath,
  images: {
    unoptimized: true,
  },
  turbopack: {
    resolveAlias: {
      '@theguild/remark-mermaid/mermaid':
        './node_modules/@theguild/remark-mermaid/dist/mermaid.js',
    },
  },
});
