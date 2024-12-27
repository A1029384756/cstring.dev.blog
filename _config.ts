import lume from "lume/mod.ts";
import picture from "lume/plugins/picture.ts";
import transformImages from "lume/plugins/transform_images.ts";
import blog from "blog/mod.ts";

const site = lume({
  location: new URL("https://cstring.dev"),
});

site.use(blog());
site.use(picture());
site.use(transformImages());

export default site;
