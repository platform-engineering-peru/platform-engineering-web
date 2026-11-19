import { verifySeedMedia } from "../src/server/media";
console.log(
  `Decoded and verified ${(await verifySeedMedia()).length} synthetic fixture images.`,
);
