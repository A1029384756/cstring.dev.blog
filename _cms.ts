import lumeCMS from "lume/cms/mod.ts";
import GitHub from "lume/cms/storage/github.ts";
import { Octokit } from "npm:octokit";
import "jsr:@std/dotenv/load";

const cms = lumeCMS();

const client = new Octokit({
  auth: Deno.env.get("GH_PAT"),
});

cms.storage(
  "gh",
  new GitHub({ client, owner: "A1029384756", repo: "cstring.dev.blog" }),
);

export default cms;
