import * as dotenv from "dotenv";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import { MongoClient, ObjectId } from "mongodb";

dotenv.config();
const httpServer = createServer();
const client = new MongoClient(process.env["ATLAS_URI"]);

const io = new Server(httpServer, {
    cors: {
        origin: process.env.NODE_ENV === "production" ? "145.239.84.215:8080" : "http://localhost:8080"
    }
});

io.on("connection", async (socket: Socket) => {
    console.log(`Socket: ${socket.id} connected`);
    console.log(socket.handshake.headers["x-real-ip"]);
    console.log(socket.handshake.headers["x-real-port"]);

    // DevMode
    let devMode = true; // Change to false after fixing the IP block issue...
    socket.on("toggleDevMode", (bool) => {
        devMode = bool;
        console.log("DevMode is: ", bool);
    })

    // Initialize database connection
    const collection = client.db("tsc").collection("codes");
    const users = client.db("tsc").collection("users");
    const ip = socket.conn.remoteAddress;

    // Retrieve codes data
    const codes = await collection.find().toArray();

    // Retrieve user
    const user = await users.findOne({ip});

    // Emit codes to the socket
    socket.emit("init", codes, user);

    // Handle on vote
    socket.on("vote", async (codeId, textId, inc) => {
        const _id = new ObjectId(codeId);
        const text_id = new ObjectId(textId);
        const user = await users.findOne({ip});

        if (user?.codes?.includes(codeId) && !devMode) {
            // If this IP has already voted on that code...
            socket.emit("alreadyVoted", _id);
        } else {
            // ...otherwise allow voting and add codeId to user codes
            const query = {_id, "texts._id": text_id};
            const update = {$inc: {"texts.$.votes" : inc ? 1 : -1}};
            const projection = {
                "_id": 1,
                "number": 1,
                "totalVotes": 1,
                "texts": {$elemMatch: {_id: text_id}}
            };
            const code = await collection.findOne(
                {"texts._id": text_id},
                {projection});

            const currentVotes = code.texts[0].votes;

            if (currentVotes <= -5 && !inc) {
                // If the vote count is -5 or below, remove that code on a negative vote...
                await collection.updateOne(query, {$pull: {texts: {_id: text_id}}});
                io.emit("receiveDelete", _id, text_id);
            } else {
                // ...otherwise add to vote count
                await collection.updateOne(query, update);
                await collection.updateOne({_id}, {$inc: {"totalVotes": inc ? 1 : currentVotes <= 0 ? 0 : -1}});
                await users.updateOne({ip}, {$addToSet: {codes: codeId}}, {upsert: true});
                const ignoreTotalVotes = (currentVotes == 0 && !inc) || (currentVotes <= -1);
                io.emit("receiveVote", _id, text_id, inc, ignoreTotalVotes);
            }
        }
    });

    // Handle adding another text, only allow adding one text for one user
    socket.on("post", async (codeId, text) => {
        const user = await users.findOne({ip});

        if (user?.added && !devMode) {
            socket.emit("alreadyAdded");
        } else {
            const postObj = {_id: new ObjectId(), text, votes: 0};
            const _id = new ObjectId(codeId);
            const query = {_id};
            const update = {$push: {texts: postObj}};
            await collection.updateOne(query, update);
            await users.updateOne({ip}, {$set: {added: true}}, {upsert: true});
            io.emit("receivePost", _id, postObj);
        }
    });

    socket.on("delete", async (codeId, textId) => {
        const _id = new ObjectId(codeId);
        const text_id = new ObjectId(textId);
        const query = {_id, "texts._id": text_id};
        const update = {$pull: {texts : {_id: textId}}};
        await collection.updateOne(query, update);
        io.emit("receiveDelete", _id, text_id);
    })


    // Development functions
    socket.on("clearUserData", async () => {
        await users.updateOne({ip}, {$set: {codes: [], added: false}});
    })

    socket.on("populateDb", async () => {
        let arr = [];
        for(let x = 400; x <= 499; ++x) {
            arr.push({
                "_id": new ObjectId(),
                number: x,
                totalVotes: 0,
                texts: []
            });
        }

        await collection.insertMany(arr);
    })
});

httpServer.listen(3000);

// const init = async () => {
//     for(let x = 400; x <=499; ++x) {
//         await collection.insertOne({
//             "_id": new ObjectId(),
//             number: x,
//             texts: [
//                 {"_id": new ObjectId(), text: `Code ${x}`, votes: 1},
//                 {"_id": new ObjectId(), text: `Code ${x}`, votes: 2},
//                 {"_id": new ObjectId(), text: `Code ${x}`, votes: 3}
//             ]
//         });
//     }
// }
//
// init();



