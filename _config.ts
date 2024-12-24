import lume from "lume/mod.ts";
import picture from "lume/plugins/picture.ts";
import transformImages from "lume/plugins/transform_images.ts";
import inline from "lume/plugins/inline.ts";
import blog from "blog/mod.ts";

const site = lume();

site.use(blog());
site.use(picture());
site.use(transformImages());
site.use(inline());

export default site;
