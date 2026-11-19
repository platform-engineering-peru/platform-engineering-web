import { publicRecords } from "./public-content";
import { blogEntries, type BlogEntry } from "./blog-model";

/** Empty content is intentional until a confirmed post is published through the administrator. */
export const blog = blogEntries(
  publicRecords("blog") as unknown as BlogEntry[],
);
