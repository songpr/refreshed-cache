//see https://alanstorm.com/async-generators-and-async-iteration-in-node-js/
const fs = require('fs');
const { parse } = require('csv-parse');

async function* readCSVByLine() {
    const readFileStream = fs.createReadStream(__dirname + "/keyword.csv");
    const csvParser = parse({});
    readFileStream.pipe(csvParser);
    for await (const record of csvParser) {
        yield record;
    }
}
test("read from csv", async () => {
    const csvGenerator = readCSVByLine();
    expect(Symbol.asyncIterator in Object(csvGenerator)).toBe(true);
    for await (const line of csvGenerator) {
        console.log(line)
    }
    
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("fetch CSV to cache", async () => {
    const cache = new (require("../index"))(readCSVByLine, { refreshAge: 1 });
    await cache.init();
    expect(cache.get("bo")).toEqual("bo");
    expect(cache.get("huh")).toEqual("huh huh");
    expect(cache.get("hi")).toEqual('hello world');
    expect(cache.size).toEqual(13);
    await delay(1100);//provide enough time to read from file
    expect(cache.get("bo")).toEqual("bo");
    expect(cache.get("huh")).toEqual("huh huh");
    expect(cache.get("hi")).toEqual('hello world');
    expect(cache.size).toEqual(13);
    await cache.close();
    
}, 10000)