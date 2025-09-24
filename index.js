const express = require("express");
require("dotenv").config();
const cors = require("cors");
const axios = require("axios");
const nodemailer = require("nodemailer");
const SSLCommerzPayment = require("sslcommerz-lts");
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
    // strict: false,
    deprecationErrors: true,
  },
});

const store_id = process.env.STORE_ID;
const store_passwd = process.env.STORE_PASSWD;
const is_live = false; //true for live, false for sandbox

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();
    const userCollection = client.db("tuitionNetworkDB").collection("users");
    const tutorRequestCollection = client
      .db("tuitionNetworkDB")
      .collection("tutorRequests");
    const paymentCollection = client
      .db("tuitionNetworkDB")
      .collection("payments");
    const tutorCollection = client.db("tuitionNetworkDB").collection("tutors");
    const VerificationCollection = client
      .db("tuitionNetworkDB")
      .collection("VerificationRequest");

    // ------------------ Custom ID Generator ------------------
    async function generateCustomId(role, collection) {
      const prefix = role === "student" ? "SID" : "TID";

      const lastUser = await collection
        .find({ role })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray();

      let newNumber = 1;
      if (lastUser.length > 0 && lastUser[0].customId) {
        const lastId = lastUser[0].customId; // যেমন SID-5
        const lastNumber = parseInt(lastId.split("-")[1]);
        newNumber = lastNumber + 1;
      }

      return `${prefix}-${newNumber}`;
    }

    // ------------------ Custom Tuition ID Generator ------------------
    async function generateTuitionId(collection) {
      const lastRequest = await collection
        .find({})
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray();

      let newNumber = 1;
      if (lastRequest.length > 0 && lastRequest[0].tuitionId) {
        newNumber = parseInt(lastRequest[0].tuitionId) + 1;
      }

      return `${newNumber}`;
    }

    //............................................

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

    // const verifyStudent = async (req, res, next) => {
    //   const email = req.decoded.email;
    //   const query = { email: email };
    //   const user = await userCollection.findOne(query);
    //   const isStudent = user?.role === "student";
    //   if (!isStudent) {
    //     return res.status(403).send({ message: "forbidden access" });
    //   }
    //   next();
    // };

    app.get("/users", async (req, res) => {
      //verifyToken,admin
      const users = await userCollection.find().toArray();
      res.send(users);
    });

    app.put("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const updatedData = req.body;

      const result = await userCollection.updateOne(
        { email },
        { $set: updatedData },
        { upsert: false }
      );

      res.send(result);
    });

    // GET /users/:email
    app.get("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        let user = await userCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ error: "User not found" });
        }

        // ✅ Auto-check subscription expiry
        if (user.profileStatus === "Premium") {
          const lastPayment = await paymentCollection.findOne(
            { email, source: "getPremium", paidStatus: true },
            { sort: { paymentTime: -1 } }
          );

          if (lastPayment) {
            const now = new Date();
            const paymentDate = new Date(lastPayment.paymentTime);
            const diffInDays = (now - paymentDate) / (1000 * 60 * 60 * 24);

            if (diffInDays >= 30) {
              // Downgrade to free
              await userCollection.updateOne(
                { email },
                { $set: { profileStatus: "Free" } }
              );
              user.profileStatus = "Free"; // update local object so frontend sees it immediately
            }
          }
        }

        res.send(user);
      } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).send({ error: "Internal server error" });
      }
    });

    // app.get("/users/:email", async (req, res) => {
    //   try {
    //     const email = req.params.email;
    //     const user = await userCollection.findOne({ email });

    //     if (user) {
    //       res.send(user);
    //     } else {
    //       res.status(404).send({ message: "User not found" });
    //     }
    //   } catch (error) {
    //     res.status(500).send({ message: "Internal server error" });
    //   }
    // });

    app.post("/users", async (req, res) => {
      const user = req.body;

      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "user already exists", insertedId: null });
      }

      // Custom ID generate
      const customId = await generateCustomId(user.role, userCollection);

      const newUser = {
        ...user,
        customId,
        createdAt: new Date(),
      };

      const result = await userCollection.insertOne(newUser);
      res.send({ ...result, customId });
    });

    app.post("/tutors", async (req, res) => {
      const tutor = req.body;

      const query = { email: tutor.email };
      const existingTutor = await tutorCollection.findOne(query);
      if (existingTutor) {
        return res.send({ message: "Tutor already exists", insertedId: null });
      }

      // Custom ID generate
      const customId = await generateCustomId("tutor", tutorCollection);

      const newTutor = {
        ...tutor,
        customId,
        createdAt: new Date(),
      };

      const result = await tutorCollection.insertOne(newTutor);
      res.send({ ...result, customId });
    });

    //.....................

    app.put("/tutors/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const updatedData = req.body;

      if (updatedData.rating) {
        const tutor = await tutorCollection.findOne({ email });

        let ratings = tutor?.ratings || [];
        ratings.push(updatedData.rating);

        // average calculation
        const averageRating =
          ratings.reduce((sum, r) => sum + r, 0) / ratings.length;

        updatedData.ratings = ratings;
        updatedData.averageRating = averageRating;
      }

      const result = await tutorCollection.updateOne(
        { email },
        { $set: updatedData },
        { upsert: true }
      );

      res.send(result);
    });

    app.get("/tutors", async (req, res) => {
      const tutors = await tutorCollection.find().toArray();
      res.send(tutors);
    });

    app.get("/tutors/:email", async (req, res) => {
      const email = req.params.email;
      const tutor = await tutorCollection.findOne({ email: email });
      res.send(tutor);
    });

    app.get("/tutors/profile/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const tutor = await tutorCollection.findOne({ customId: id });
        if (!tutor) {
          return res.status(404).send({ message: "Tutor not found" });
        }
        res.send(tutor);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
      }
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

        const tuitionId = await generateTuitionId(tutorRequestCollection);
        tutorRequest.tuitionId = tuitionId;

        const result = await tutorRequestCollection.insertOne({
          ...tutorRequest,
          createdAt: new Date(),
        });

        res.status(201).send({
          message: "Tutor request submitted successfully",
          insertedId: result.insertedId,
          tuitionId: tutorRequest.tuitionId,
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

    // Get all confirmed tutors for a specific tutor email
    app.get("/confirmedTutors/:email", async (req, res) => {
      const userEmail = req.params.email.toLowerCase();

      try {
        // Find all tutor requests where this tutor applied and got confirmed
        const posts = await tutorRequestCollection
          .find({ "appliedTutors.email": tutorEmail })
          .toArray();

        // Filter only confirmed tutors
        const confirmedTutors = posts
          .map((post) =>
            post.appliedTutors
              .filter(
                (tutor) =>
                  tutor.email.toLowerCase() === tutorEmail &&
                  tutor.confirmationStatus === "confirmed"
              )
              .map((tutor) => ({
                name: tutor.name,
                email: tutor.email,
                photoURL:
                  tutor.photoURL ||
                  "https://i.ibb.co/7n4R8Rt/default-avatar.png",
                postId: post._id,
                location: post.location,
                salary: post.salary,
                duration: post.duration,
              }))
          )
          .flat();

        res.status(200).json(confirmedTutors);
      } catch (error) {
        console.error("Error fetching confirmed tutors:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // approve and apply jobs ,update tutor requests
    app.put("/tutorRequests/:id", async (req, res) => {
      const { id } = req.params;
      const { email, name, tutorId, status, tutorStatus } = req.body;

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
            tutorId,
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

          const tutorRequest = await tutorRequestCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!tutorRequest) {
            return res
              .status(404)
              .send({ message: "Tutor request not found." });
          }

          const updatedTutors = tutorRequest.appliedTutors.map((tutor) => {
            if (tutor.email === confirmedTutorEmail) {
              return { ...tutor, confirmationStatus: "confirmed" };
            } else {
              const { confirmationStatus, ...rest } = tutor;
              return rest;
            }
          });

          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { appliedTutors: updatedTutors } }
          );

          if (result.modifiedCount > 0) {
            return res.send({ message: "Tutor confirmed successfully." });
          } else {
            return res
              .status(400)
              .send({ message: "Failed to confirm tutor." });
          }
        }

        // Canceling a tutor confirmation
        if (req.body.cancelConfirmation) {
          const tutorRequest = await tutorRequestCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!tutorRequest) {
            return res
              .status(404)
              .send({ message: "Tutor request not found." });
          }

          const updatedTutors = tutorRequest.appliedTutors.map(
            ({ confirmationStatus, ...rest }) => rest
          );

          result = await tutorRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { appliedTutors: updatedTutors } }
          );

          if (result.modifiedCount > 0) {
            return res.send({
              message: "Tutor confirmation cancelled successfully.",
            });
          } else {
            return res
              .status(400)
              .send({ message: "Failed to cancel confirmation." });
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
        const tutor = await tutorCollection.findOne({ email: email });
        if (!tutor) {
          return res.status(404).send({ message: "Tutor not found" });
        }
        res.send(tutor);
      } catch (error) {
        console.error("Error fetching tutor:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // GET applied tutors for jobId
    app.get("/appliedTutorForJobId/:jobId", async (req, res) => {
      const jobId = req.params.jobId;

      try {
        const job = await tutorRequestCollection.findOne({
          _id: new ObjectId(jobId),
        });
        if (!job) {
          return res.status(404).json({ message: "Job not found" });
        }
        res.json(job.appliedTutors || []);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
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

    app.get("/paymentBkash", async (req, res) => {
      //verifyToken,admin
      const paymentBkash = await paymentCollection.find().toArray();
      res.send(paymentBkash);
    });

    //payment related api

    app.post("/paymentBkash", async (req, res) => {
      const {
        jobId,
        name,
        email,
        tutorId,
        amount,
        tutorAmount,
        tuToriaAmount,
        source,
        studentEmail,
        studentName,
        role,
        productName = "Tuition Payment",
      } = req.body;
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
      sslcz.init(data).then((apiResponse) => {
        res.send({ url: apiResponse.GatewayPageURL });

        paymentCollection.insertOne({
          jobId,
          transactionId: tran_id,
          amount,
          tutorAmount,
        tuToriaAmount,
          email,
          tutorId,
          name,
          source,
          studentEmail,
          studentName,
          role,
          paidStatus: false,
          paymentTime: new Date(),
        });
      });
    });
    // SUCCESS Route (Dynamic redirect)
    app.post("/payment/success/:tranId", async (req, res) => {
      const payment = await paymentCollection.findOne({
        transactionId: req.params.tranId,
      });

      if (!payment) {
        return res.status(404).send("Payment not found");
      }

      await paymentCollection.updateOne(
        { transactionId: req.params.tranId },
        { $set: { paidStatus: true } }
      );

      if (payment.source === "myApplications") {
        res.redirect(
          `http://localhost:5173/tutor/payment/success/${req.params.tranId}`
        );
      } else if (payment.source === "trialClassPayment") {
        res.redirect(
          `http://localhost:5173/student/payment/success/${req.params.tranId}`
        );
      } else if (payment.source === "advanceSalary") {
        res.redirect(
          `http://localhost:5173/student/payment/success/${req.params.tranId}`
        );
      } else if (payment.source === "getPremium") {
        res.redirect(
          `http://localhost:5173/${payment.role}/payment/success/${req.params.tranId}`
        );
      } else if (payment.source === "contactTutor") {
        res.redirect(
          `http://localhost:5173/payment/success/${req.params.tranId}`
        );
      }
    });

    // FAIL Route (Dynamic redirect)
    app.post("/payment/fail/:tranId", async (req, res) => {
      const payment = await paymentCollection.findOne({
        transactionId: req.params.tranId,
      });

      if (!payment) {
        return res.status(404).send("Payment not found");
      }

      await paymentCollection.deleteOne({ transactionId: req.params.tranId });

      if (payment.source === "myApplications") {
        res.redirect(`http://localhost:5173/tutor/myApplications`);
      } else if (payment.source === "trialClassPayment") {
        res.redirect(`http://localhost:5173/student/hired-tutors`);
      } else if (payment.source === "advanceSalary") {
        res.redirect(`http://localhost:5173/student/hired-tutors`);
      } else if (payment.source === "getPremium") {
        res.redirect(`http://localhost:5173/${payment.role}/settings/premium`);
      } else if (payment.source === "contactTutor") {
        res.redirect(
          `http://localhost:5173/tutors/tutor-profile/${payment.tutorId}`
        );
      }
    });

    app.get("/payment/success/:tranId", async (req, res) => {
      const tranId = req.params.tranId;

      try {
        const payment = await paymentCollection.findOne({
          transactionId: tranId,
        });

        if (!payment) {
          return res.status(404).json({ message: "Payment not found" });
        }

        res.status(200).json(payment);
      } catch (error) {
        console.error("Error fetching payment:", error);
        res.status(500).json({ message: "Internal server error" });
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

    ////paymentHistory-tutor

    app.get("/tutor/paidJobs/:email", async (req, res) => {
      const email = req.params.email;

      const payments = await paymentCollection
        .find({ email, paidStatus: true, source: "myApplications" })
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

    //paymentHistory-student + Hired Tutors
    app.get("/student/paidJobs/:studentEmail", async (req, res) => {
      const studentEmail = req.params.studentEmail;

      const payments = await paymentCollection
        .find({ studentEmail, paidStatus: true })
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

    app.post("/payments/multiple", async (req, res) => {
      const { jobIds } = req.body;
      if (!Array.isArray(jobIds))
        return res.status(400).send("jobIds must be an array");

      try {
        const payments = await paymentCollection
          .find({
            jobId: { $in: jobIds },
          })
          .toArray();

        res.json(payments);
      } catch (error) {
        res.status(500).send("Server error");
      }
    });

    app.post("/verification", async (req, res) => {
      try {
        const {
          name,email,phone,customId,idImage,NidImage,city,location,verificationStatus
        } = req.body;

        // Check if already submitted
        const existing = await VerificationCollection.findOne({ email });
        if (existing) {
          return res.status(400).json({ message: "Request already submitted" });
        }

        // insert directly (no constructor)
        const newRequest = {
          name,
          email,
          phone,
          customId,
          idImage,
          NidImage,
          city,
          location,
          verificationStatus,
          createdAt: new Date(),
        };

        await VerificationCollection.insertOne(newRequest);

        res.status(201).json({ message: "Verification request submitted" });
      } catch (error) {
        console.error("Error saving request:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.get("/verification", async (req, res) => {
      //verifyToken,admin
      const verification = await VerificationCollection.find().toArray();
      res.send(verification);
    });

    //...........
    // Nominatim geocode proxy
    app.get("/geocode", async (req, res) => {
      const { q } = req.query; // ?q=location_query
      if (!q)
        return res.status(400).json({ error: "Missing query parameter q" });

      try {
        const response = await axios.get(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
            q
          )}`,
          {
            headers: {
              "Accept-Language": "en",
              "User-Agent": "tuToria (hafsa.cse28gmail.com)",
            },
          }
        );

        res.json(response.data);
      } catch (err) {
        console.error("Geocoding error:", err.message);
        res.status(500).json({ error: "Geocoding failed" });
      }
    });

    //............................Email

    app.post("/contact", (req, res) => {
      const { tutorName, studentName, tutorEmail, studentEmail,studentPhone, message } =
        req.body;

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      const mailOptions = {
        from: studentEmail,
        to: tutorEmail,
        subject: `Tuition Request from ${studentName}`,
        text: `
Dear ${tutorName},

I hope this message finds you well.

My name is ${studentName}. I came across your profile and was impressed by your expertise. I am interested in receiving tuition from you and would like to discuss the possibility of learning under your guidance.

Here are my details:

Name: ${studentName}
Email: ${studentEmail}
Phone: ${studentPhone}

Message:
${message}

I would greatly appreciate it if you could consider my request and respond at your convenience.

Thank you very much for your time and consideration.

Best regards,
${studentName}
`,
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.error("Error sending email:", error);
          res.status(500).send("Failed to send message.");
        } else {
          console.log("Email sent:", info.response);
          res.status(200).send("Message sent successfully!");
        }
      });
    });

    //...............................................

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
