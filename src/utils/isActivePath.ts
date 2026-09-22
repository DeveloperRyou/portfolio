import { stripBase, stripLocale } from "@/utils/withBase";

/**
 * Builds an `isActive(path)` matcher for nav-link highlighting, given the
 * current request's pathname and locale. Shared by Header (desktop nav)
 * and Sidebar (mobile nav) so both highlight the same route the same way.
 */
export function getIsActivePath(pathname: string, locale: string) {
  const relativePath = stripBase(pathname);
  const pathWithoutTrailingSlash =
    relativePath.endsWith("/") && relativePath !== "/"
      ? relativePath.slice(0, -1)
      : relativePath;
  const currentPath = stripLocale(pathWithoutTrailingSlash, locale);

  return (path: string) => {
    const currentPathArray = currentPath.split("/").filter(p => p.trim());
    const pathArray = path.split("/").filter(p => p.trim());
    return currentPath === path || currentPathArray[0] === pathArray[0];
  };
}
