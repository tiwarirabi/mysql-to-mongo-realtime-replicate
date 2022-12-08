const mysql = require("mysql");
const dotenv = require("dotenv");
const MySQLEvents = require("@rodrigogs/mysql-events");
const { MongoClient } = require("mongodb");

dotenv.config();

const mongoDBName = process.env.MONGODB_NAME;
const mySqlDBName = process.env.MYSQL_DB_NAME;

const config = {
  mysql: {
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_ROOT_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  },
  mongodb: process.env.MONGODB_URL,
};

const executeMySqlQuery = (connection, query) =>
  new Promise((resolve, reject) => {
    connection.query(query, (error, results, fields) => {
      if (error) reject(error);
      resolve(results);
    });
  });

const mySqlToMongo = async (connection, client, tableName) => {
  const query = `SELECT * FROM ${tableName}`;
  const data = await executeMySqlQuery(connection, query);
  if (data && data.length) {
    await client.collection(tableName).insertMany(data.map((d) => d));
  }
};

const handleFullDump = async (connection, client) => {
  console.time("Full Dump");
  await client.dropDatabase();
  connection.connect(function (err) {
    if (err) throw err;
  });

  const query = `SELECT table_name FROM information_schema.tables WHERE TABLE_SCHEMA='${mySqlDBName}'`;

  const results = await executeMySqlQuery(connection, query);

  const tableNames = results.map((r) => r.TABLE_NAME);

  await Promise.all(
    tableNames.map((tableName) => {
      mySqlToMongo(connection, client, tableName);
    })
  );

  console.timeEnd("Full Dump");
};

const updateMany = async (mongoCollection, data) =>
  await Promise.all(
    data.map((d) =>
      mongoCollection.updateOne({ id: d.id }, { $set: d }, { upsert: true })
    )
  );

const deleteMany = async (mongoCollection, data) =>
  await Promise.all(data.map((d) => mongoCollection.deleteOne({ id: d.id })));

const main = async () => {
  const connection = mysql.createConnection(config.mysql);

  const instance = new MySQLEvents(connection, {
    startAtEnd: true,
  });

  await instance.start();

  // Setup MongoDb connection
  const dbOptions = {
    authSource: "admin",
    useNewUrlParser: true,
    useUnifiedTopology: true,
  };

  const client = new MongoClient(config.mongodb);
  const mongoDb = await client.db(mongoDBName);

  await handleFullDump(connection, mongoDb);

  const handleChanges = async ({ table, type, affectedRows }) => {
    const data = affectedRows.map((row) => row.after);

    console.log(`INCOMING: ${data.length}, TYPE: ${type}, TABLE: ${table}`);
    try {
      const mongoCollection = mongoDb.collection(table);
      let result;
      if (type === "UPDATE") {
        result = await updateMany(mongoCollection, data);
      } else if (type === "INSERT") {
        result = await mongoCollection.insertMany(data, options);
      } else if (type === "DELETE") {
        result = await deleteMany(mongoCollection, data);
      }
      console.log(`DONE: ${data.length}, TYPE: ${type}, TABLE: ${table}`);
    } catch (error) {
      console.log("ERROR MESSAGE: ", error.message);
      console.log("ERROR STACK: ", error.stack);
      console.log("DATA: ", data);
    }
  };

  instance.addTrigger({
    name: "TEST",
    expression: "*",
    statement: MySQLEvents.STATEMENTS.ALL,
    onEvent: async (event) => {
      handleChanges(event);
    },
  });

  instance.on(MySQLEvents.EVENTS.CONNECTION_ERROR, console.error);
  instance.on(MySQLEvents.EVENTS.ZONGJI_ERROR, console.error);
};

main()
  .then(() => console.log("Waiting for database events..."))
  .catch(console.error);
