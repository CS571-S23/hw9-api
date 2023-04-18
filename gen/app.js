import * as fs from 'fs';

const arts = fs.readdirSync("articles").map((artName, i) => {
    const f = fs.readFileSync(`articles/${artName}`).toString();
    const lns = f.split(/\r\n/g);
    const headline = lns[0];
    const img = lns[1];
    const tags = lns[2].trim().split(",");
    const bodyParas = lns.slice(3).filter(ln => ln.trim() !== "");
    return {
        id: i,
        img: img,
        title: headline,
        tags: tags,
        body: bodyParas
    }
});

fs.writeFileSync("../includes/articles.json", JSON.stringify(arts, null, 2));
