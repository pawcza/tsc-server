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
    // Initialize database connection
    const collection = client.db("tsc").collection("codes");
    const users = client.db("tsc").collection("users");
    const ip = socket.handshake.headers["x-real-ip"] || "::ffff:127.0.0.1";

    // Retrieve codes data
    const codes = await collection.find().toArray();

    // Retrieve user or create one if it doesn't exist
    const getUserData = async () => {
        const result = await users.findOneAndUpdate(
            { ip },
            {
                $setOnInsert: {
                    _id: new ObjectId(),
                    ip,
                    codes: []
                },
            },
            {
                returnDocument: "after",
                upsert: true,
            });

        return result.value;
    }

    const user = await getUserData();

    // Log user data
    console.log(`Socket: ${socket.id} connected, User IP: ${ip}, Date: ${new Date()}`);

    // DevMode
    let devMode = false;
    socket.on("toggleDevMode", (bool) => {
        devMode = bool;
        console.log(`DevMode is: ${bool} initiated by ${ip} on ${new Date()}`);
    })


    // Emit codes to the socket
    const clientFacingUser = {
        codes: user.codes,
        _id: user._id
    }
    socket.emit("init", codes, clientFacingUser);

    // Handle on vote
    socket.on("vote", async (codeId, textId, inc) => {
        const _id = new ObjectId(codeId);
        const text_id = new ObjectId(textId);
        const user = await getUserData();

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
                io.emit("receiveVote", _id, text_id, inc, ignoreTotalVotes, user._id);
            }
        }
    });

    // Handle adding another text, only allow adding one text for one user
    socket.on("post", async (codeId, text, userId) => {
        const user = await getUserData();

        if (user?.added && !devMode) {
            socket.emit("alreadyAdded");
        } else {
            const postObj = {_id: new ObjectId(), text, votes: 0};
            const _id = new ObjectId(codeId);
            const query = {_id};
            const update = {$push: {texts: postObj}};
            await collection.updateOne(query, update);
            await users.updateOne({ip}, {$set: {added: true}}, {upsert: true});
            io.emit("receivePost", _id, postObj, user._id);
        }
    });

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

