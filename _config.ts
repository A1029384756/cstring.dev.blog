import lume from "lume/mod.ts";
import plugins, {Options} from "./plugins.ts";

const site = lume({
  src: "./src",
  location: new URL("https://cstring.dev"),
});

const options: Options = {}

site.use(plugins(options));

export default site;
