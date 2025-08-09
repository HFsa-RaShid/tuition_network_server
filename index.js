const express = require("express");
require("dotenv").config();
const cors = require("cors");
const SSLCommerzPayment = require('sslcommerz-lts')
const jwt = require("jsonwebtoken");
const app = express();
const { ObjectId } = require("mongodb");

const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

const { MongoClient, ServerApiVersion } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.aq8mwv9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});


const store_id = process.env.STORE_ID;
const store_passwd = process.env.STORE_PASSWD;
const is_live = false //true for live, false for sandbox


async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();
    const userCollection = client.db("tuitionNetworkDB").collection("users");
    const tutorRequestCollection = client.db("tuitionNetworkDB").collection("tutorRequests");
    const paymentCollection = client.db("tuitionNetworkDB").collection("payments");
    // auth related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      // console.log('user for token', user);
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });
      res.send({ token });
    });

    // Users related API

    const verifyToken = (req, res, next) => {
      // console.log('inside verifyToken', req.headers.authorization);
      // next();
      if (!req.headers.authorization) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = req.headers.authorization.split(" ")[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res.status(401).send({ message: "unauthorized access" });
        }
        req.decoded = decoded;
        next();
      });
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      const isAdmin = user?.role === "admin";
      if (!isAdmin) {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    const verifyStudent = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      const isStudent = user?.role === "student";
      if (!isStudent) {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    app.get("/users", async (req, res) => {
      //varifytoken,admin
      const users = await userCollection.find().toArray();
      res.send(users);
    });

    app.put("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const updatedData = req.body;

      const result = await userCollection.updateOne(
        { email },
        { $set: updatedData },
        { upsert: true }
      );

      res.send(result);
    });

    app.get("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await userCollection.findOne({ email });

        if (user) {
          res.send(user);
        } else {
          res.status(404).send({ message: "User not found" });
        }
      } catch (error) {
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // Post new user
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "user already exists", insertedId: null });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // delete user by admin
    app.delete("/users/:email", verifyToken, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const result = await userCollection.deleteOne({ email });
      res.send(result);
    });

    // get users by search
    app.get("/searchUsers", async (req, res) => {
      const searchTerm = req.query.q.toLowerCase();
      const users = await userCollection
        .find({
          role: { $ne: "admin" },
          $or: [
            { name: { $regex: searchTerm, $options: "i" } },
            { email: { $regex: searchTerm, $options: "i" } },
          ],
        })
        .toArray();
      res.send(users);
    });

    // Post tutor request
    app.post("/tutorRequests", verifyToken, async (req, res) => {
      try {
        const tutorRequest = req.body;
        const result = await tutorRequestCollection.insertOne(tutorRequest);
        res.status(201).send({
          message: "Tutor request submitted successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Error submitting tutor request" });
      }
    });

    // get all tutor requests
    app.get("/tutorRequests", async (req, res) => {
      const result = await tutorRequestCollection.find().toArray();
      res.send(result);
    });

    // approve and apply jobs ,update tutor requests
    app.put("/tutorRequests/:id", async (req, res) => {
      const { id } = req.params;
      const { email, name, tutorDetails, status, tutorStatus } = req.body;

      try {
        let result;
        if (tutorStatus) {
          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { tutorStatus } }
          );

          if (result.modifiedCount > 0) {
            return res.send({ message: "Tutor status updated successfully." });
          } else {
            return res
              .status(404)
              .send({ message: "Request not found or not modified." });
          }
        }

        // Applying for a tutor request

        if (email) {
          const applyObject = {
            email,
            name,
            appliedAt: new Date(),
          };

          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id), "appliedTutors.email": { $ne: email } },
            { $push: { appliedTutors: applyObject } }
          );

          if (result.modifiedCount > 0) {
            return res.send({ message: "Applied successfully." });
          } else {
            return res
              .status(400)
              .send({ message: "Already applied or request not found." });
          }
        }
        // Updating tutor request status by admin
        if (status !== undefined) {
          let updateQuery;

          if (status === "") {
            updateQuery = { $unset: { status: "" } };
          } else {
            updateQuery = { $set: { status } };
          }

          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            updateQuery
          );

          if (result.modifiedCount > 0) {
            return res.send({ message: "Status updated successfully." });
          } else {
            return res
              .status(404)
              .send({ message: "Request not found or not modified." });
          }
        }

        // Updating tutor details or changing request status
        if (tutorStatus !== undefined) {
          let updateQuery;

          // If the frontend sent empty string: unset the field
          if (tutorStatus === "") {
            updateQuery = { $unset: { tutorStatus: "" } };
          } else {
            updateQuery = { $set: { tutorStatus } };
          }

          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            updateQuery
          );

          if (result.modifiedCount > 0) {
            return res.send({ message: "Tutor status updated successfully." });
          } else {
            return res
              .status(404)
              .send({ message: "Request not found or not modified." });
          }
        }

        // Confirming a tutor
if (req.body.confirmedTutorEmail) {
  const { confirmedTutorEmail } = req.body;

  // First, fetch the current tutor request
  const tutorRequest = await tutorRequestCollection.findOne({ _id: new ObjectId(id) });

  if (!tutorRequest) {
    return res.status(404).send({ message: "Tutor request not found." });
  }

  const updatedTutors = tutorRequest.appliedTutors.map((tutor) => {
    if (tutor.email === confirmedTutorEmail) {
      return { ...tutor, confirmationStatus: "confirmed" };
    } else {
      const { confirmationStatus, ...rest } = tutor;
      return rest; // remove confirmationStatus if exists
    }
  });

  result = await tutorRequestCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { appliedTutors: updatedTutors } }
  );

  if (result.modifiedCount > 0) {
    return res.send({ message: "Tutor confirmed successfully." });
  } else {
    return res.status(400).send({ message: "Failed to confirm tutor." });
  }
}

// Canceling a tutor confirmation
if (req.body.cancelConfirmation) {
  // Find the tutor request
  const tutorRequest = await tutorRequestCollection.findOne({ _id: new ObjectId(id) });

  if (!tutorRequest) {
    return res.status(404).send({ message: "Tutor request not found." });
  }

  // Remove confirmationStatus from all tutors
  const updatedTutors = tutorRequest.appliedTutors.map(({ confirmationStatus, ...rest }) => rest);

  result = await tutorRequestCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { appliedTutors: updatedTutors } }
  );

  if (result.modifiedCount > 0) {
    return res.send({ message: "Tutor confirmation cancelled successfully." });
  } else {
    return res.status(400).send({ message: "Failed to cancel confirmation." });
  }
}

        // If no valid fields provided
        return res
          .status(400)
          .send({ message: "Nothing to update. Provide valid fields." });
      } catch (error) {
        // Log the detailed error and send a generic message to the client
        console.error("Error in PUT /tutorRequests/:id:", error);
        return res
          .status(500)
          .send({ message: "Server error. Please try again later." });
      }
    });

    // GET tutor info by email
    app.get("/appliedTutors/:email", async (req, res) => {
      const email = req.params.email.toLowerCase();
      try {
        const tutor = await userCollection.findOne({ email: email });
        if (!tutor) {
          return res.status(404).send({ message: "Tutor not found" });
        }
        res.send(tutor);
      } catch (error) {
        console.error("Error fetching tutor:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // delete tutor request by admin
    app.delete("/tutorRequests/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const result = await tutorRequestCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        console.error("Error deleting job:", error);
        res.status(500).send({ error: "Failed to delete job" });
      }
    });


    //payment related api

app.post("/paymentBkash", async (req, res) => {
  const { jobId, name, email, amount, source, productName = "Tuition Payment" } = req.body;
  const tran_id = new ObjectId().toString();

  const data = {
    total_amount: amount,
    currency: "BDT",
    tran_id,
    success_url: `http://localhost:5000/payment/success/${tran_id}`,
    fail_url: `http://localhost:5000/payment/fail/${tran_id}`,
    cancel_url: `http://localhost:5000/paymentCancel`,
    ipn_url: `http://localhost:5000/ipn`,
    shipping_method: "Courier",
    product_name: productName,
    product_category: "Tuition",
    product_profile: "general",
    cus_name: name,
    cus_email: email,
    cus_add1: "Dhaka",
    cus_add2: "Dhaka",
    cus_city: "Dhaka",
    cus_state: "Dhaka",
    cus_postcode: "1000",
    cus_country: "Bangladesh",
    cus_phone: "01711111111",
    cus_fax: "01711111111",
    ship_name: "Customer Name",
    ship_add1: "Dhaka",
    ship_add2: "Dhaka",
    ship_city: "Dhaka",
    ship_state: "Dhaka",
    ship_postcode: 1000,
    ship_country: "Bangladesh",
  };

  const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
  sslcz.init(data).then(apiResponse => {
    res.send({ url: apiResponse.GatewayPageURL });

    paymentCollection.insertOne({
      jobId,
      transactionId: tran_id,
      amount,
      email,
      name,
      source, 
      paidStatus: false,
      paymentTime: new Date(),
    });
  });
});
// SUCCESS Route (Dynamic redirect)
app.post("/payment/success/:tranId", async (req, res) => {
  const payment = await paymentCollection.findOne({ transactionId: req.params.tranId });

  if (!payment) {
    return res.status(404).send("Payment not found");
  }

  await paymentCollection.updateOne(
    { transactionId: req.params.tranId },
    { $set: { paidStatus: true } }
  );

  if (payment.source === "myApplications") {
    res.redirect(`http://localhost:5173/tutor/payment/success/${req.params.tranId}`);
  } else if (payment.source === "appliedTutors") {
    res.redirect(`http://localhost:5173/student/payment/success/${req.params.tranId}`);
  } 
});

// FAIL Route (Dynamic redirect)
app.post("/payment/fail/:tranId", async (req, res) => {
  const payment = await paymentCollection.findOne({ transactionId: req.params.tranId });

  if (!payment) {
    return res.status(404).send("Payment not found");
  }

  await paymentCollection.deleteOne({ transactionId: req.params.tranId });

  if (payment.source === "myApplications") {
    res.redirect(`http://localhost:5173/tutor/myApplications`);
  } else if (payment.source === "appliedTutors") {
    res.redirect(`http://localhost:5173/student/posted-jobs/applied-tutors`);
  }
});


app.get('/payment/success/:tranId', async (req, res) => {
  const tranId = req.params.tranId;

  try {
    const payment = await paymentCollection.findOne({ transactionId: tranId });

    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    res.status(200).json(payment);
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


   // GET all payments for a jobId
app.get("/payments/:jobId", async (req, res) => {
  const { jobId } = req.params;
  try {
    const payments = await paymentCollection
      .find({ jobId, paidStatus: true })
      .toArray(); // if using MongoDB native driver
    res.status(200).json(payments);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch payment data" });
  }
});


//Get all paid jobs for a user

app.get("/user/paidJobs/:email", async (req, res) => {
  const email = req.params.email;

  const payments = await paymentCollection
    .find({ email, paidStatus: true })
    .toArray();

  const paidJobIds = payments.map((p) => new ObjectId(p.jobId));

  const jobs = await tutorRequestCollection
    .find({ _id: { $in: paidJobIds } })
    .toArray();

  // Merge payment info with job info
  const merged = payments.map((payment) => {
    const job = jobs.find((j) => j._id.toString() === payment.jobId);
    return {
      ...payment,
      jobDetails: job || null,
    };
  });

  res.send(merged);
});


    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Welcome to the server");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
