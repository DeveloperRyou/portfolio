/**
 * Shiki themes for code blocks, shared by the markdown pipeline
 * (astro.config.ts) and the styleguide's `<Code>` specimen so both render
 * the same. Only token colors come from these themes: the block background
 * is theme.css's `--code-bg`, a Radix slate step.
 */
export const codeThemes = /** @type {const} */ ({
  light: "github-light-default",
  dark: "github-dark-default",
});

/**
 * github-light-default's comment gray (#6e7781) is ~4.3:1 on `--code-bg`,
 * below WCAG AA; swap it for `--muted-foreground`'s slate11. Done as a
 * transformer rather than Shiki's `colorReplacements` because Astro's
 * `<Code>` component doesn't accept that option.
 */
export const transformerCommentContrast = () => ({
  span(node) {
    const style = node.properties.style;
    if (typeof style === "string") {
      node.properties.style = style.replace(
        /--shiki-light:#6e7781/i,
        "--shiki-light:#60646c"
      );
    }
  },
});
