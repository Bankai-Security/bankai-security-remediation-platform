import { Router } from "express";
import multer from "multer";
import { getScan, listScans, uploadScan } from "../controllers/scan.controller.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const scanRouter = Router({ mergeParams: true });

scanRouter.get("/", listScans);
scanRouter.post("/", upload.single("file"), uploadScan);
scanRouter.get("/:scanId", getScan);
