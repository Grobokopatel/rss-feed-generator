import 'dotenv/config';

import {fileURLToPath} from 'url';
import {dirname} from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {HttpsProxyAgent} from "https-proxy-agent";
import {HttpProxyAgent} from 'http-proxy-agent';
import fetch, {FetchError} from 'node-fetch';
import urlNode from "node:url";
import cons from "@ladjs/consolidate";
import {Feed} from "feed";
import * as cheerio from 'cheerio';
import {sql} from "@vercel/postgres";
import path from "node:path";
import express from "express";
import {ZenRows} from "zenrows";
import * as util from 'node:util';

const RUSSIAN_PROXY_URL = process.env.RUSSIAN_PROXY_URL;

const app = express();


app.engine('handlebars', cons.handlebars);
app.use(express.urlencoded({extended: true}));
app.use(express.static(path.join(__dirname, '..', 'static')));
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view engine', 'handlebars');


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'static', 'index.html'));
});

app.get('/my_feeds/:id', async (req, res) => {
    let queryResult;
    try {
        queryResult = await sql`
            select id, url, selectors, last_time_updated, content
            from feed
            where id = ${req.params.id};
        `;
    } catch (error) {
        console.error(error);
        res.status(500).json({error});
        return;
    }

    let {rows} = queryResult;
    if (rows.length === 0) {
        res.status(404).send(`Нет ленты с таким id: ${req.params.id}`);
        return;
    } else {
        let {id, url, selectors, last_time_updated, content} = rows[0];
        try {
            let response = await tryFetchElseFetchWithProxy(url);
            let html = await response.text();
            let $cheerioAPI = await cheerio.load(html);

            let post = {
                link: url
            };

            let {
                title,
                description,
                imageEnclosure
            } = await getTitleDescriptionAndImageEnclosure($cheerioAPI, selectors, url);

            post.title = title;
            post.description = description;
            post.image = imageEnclosure;

            let currentContent = post.title + ';' + post.description + ';' + imageEnclosure?.url;

            let lastTimeUpdated = last_time_updated;
            if (content !== currentContent) {
                lastTimeUpdated = new Date();

                await sql`
                    update feed
                    set last_time_updated = ${lastTimeUpdated},
                        content           = ${currentContent}
                    where id = ${id};
                `;
            }

            post.id = url + '#' + +lastTimeUpdated;
            post.date = lastTimeUpdated;

            const feed = new Feed({
                title: $cheerioAPI('title').html(),
                description: "Сайт для генерации собственных RSS лент",
                link: url,
                language: "ru",
            });

            feed.addItem(post);
            let rssPost = feed.rss2();
            res.contentType('text/xml').send(rssPost);
            return;
        } catch (error) {
            console.error(error);
            res.status(500).json({error});
            return;
        }
    }
});

async function getTitleDescriptionAndImageEnclosure($cheerioAPI, selectors, url) {
    return {
        title: $cheerioAPI(selectors.title).prop('innerText'),
        description: $cheerioAPI(selectors.description).html(),
        imageEnclosure: await getImageEnclosure(selectors.image, url, $cheerioAPI),
    };
}

async function getImageEnclosure(imageSelector, url, $cheerioAPI) {
    if (!imageSelector)
        return null;

    let imageElement = $cheerioAPI(imageSelector);
    let imageUrl = imageElement.prop('src');
    if (imageUrl === undefined) {
        imageUrl = imageElement.find('img[src]').prop('src');
    }

    imageUrl = urlNode.resolve(url, imageUrl);
    let imageInfo = await tryFetchElseFetchWithProxy(imageUrl, {method: 'HEAD'});
    let headers = imageInfo.headers;
    
    return {
        url: imageUrl,
        type: headers.get('content-type'),
        length: parseInt((headers.get('content-length'))),
    };
}

app.post('/', async (req, res) => {
    let body = req.body;
    let selectors = {title: body.title, description: body.description, image: body.image};
    let queryResult;
    let today = new Date();
    try {
        queryResult = await sql`
            insert into feed(url, selectors, last_time_updated)
            values (${body.url},
                    ${selectors},
                    ${today})
            returning id;
        `;
    } catch (error) {
        console.error(error);
        res.status(500).json({error});
        return;
    }

    res.render('preview', {
        path: `/my_feeds/${queryResult.rows[0].id}`,
        url: `https://${process.env.VERCEL_URL}/${queryResult.rows[0].id}`
    });
});

app.post('/preview', async (req, res) => {
    let body = req.body;
    let response = await tryFetchElseFetchWithProxy(body.url);
    let html = await response.text();
    let $cheerioAPI = await cheerio.load(html);
    let selectors = {title: body.title, description: body.description, image: body.image};
    let {
        title,
        description,
        imageEnclosure
    } = await getTitleDescriptionAndImageEnclosure($cheerioAPI, selectors, body.url);
    res.render('example', {title, description, image: imageEnclosure?.url});
});

async function tryFetchElseFetchWithProxy(url, options = {}) {
    try {
        let response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`Got response code outside of 200-299: ${response.status} ${response.statusText}.\n` +
            `Headers: ${util.inspect(response.headers)}`);
        }
        
        return response;
    } catch (error) {
        console.error(error);
        options.agent = new HttpsProxyAgent(RUSSIAN_PROXY_URL);
        options.method = 'GET';
        let response = await fetch(url, options);
        
        if (!response.ok) {
            throw new Error(`Got response code outside of 200-299: ${response.status} ${response.statusText}.\n` +
            `Headers: ${util.inspect(response.headers)}`);
        }
        
        let headers = response.headers;
        headers.set('content-length', headers.get('zr-content-length'));
        headers.set('content-type', headers.get('zr-content-type'));
        
        return response;
    }
}

export default app;