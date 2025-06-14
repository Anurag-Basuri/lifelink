import mongoose from "mongoose";
import { NGO } from "../../models/users/ngo.models.js";
import {
    Facility,
    FACILITY_TYPE,
} from "../../models/donation/facility.models.js";
import { BloodRequest } from "../../models/donation/bloodrequest.models.js";
import { Activity } from "../../models/others/activity.model.js";
import { Notification } from "../../models/others/notification.model.js";
import { User } from "../../models/users/user.models.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { uploadFile } from "../../utils/fileUpload.js";
import notificationService from "../../services/notification.service.js";

// Enums and Constants
export const NGO_STATUS = {
    PENDING: "PENDING",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    BLACKLISTED: "BLACKLISTED",
};

export const FACILITY_OPERATIONS = {
    CREATE: "create",
    UPDATE: "update",
    DELETE: "delete",
    SUSPEND: "suspend",
    ACTIVATE: "activate",
    LIST: "LIST",
};

// Helper: Generate tokens for NGO
const generateTokens = async (ngoId) => {
    const ngo = await NGO.findById(ngoId);
    const accessToken = ngo.generateAccessToken();
    const refreshToken = ngo.generateRefreshToken();

    ngo.refreshToken = refreshToken;
    ngo.lastLogin = new Date();
    await ngo.save({ validateBeforeSave: false });
    return { accessToken, refreshToken };
};

// Registration
const registerNGO = asyncHandler(async (req, res) => {
    const {
        name,
        email,
        password,
        contactPerson,
        address,
        regNumber,
        facilities,
        organizationType,
        operatingHours,
    } = req.body;

    // Validation
    if (!name?.trim()) throw new ApiError(400, "NGO name is required");
    if (!email?.trim()) throw new ApiError(400, "Email is required");
    if (!password?.trim() || password.length < 8)
        throw new ApiError(400, "Password must be at least 8 characters");
    if (!contactPerson?.name || !contactPerson?.phone)
        throw new ApiError(400, "Contact person details required");
    if (!regNumber?.trim())
        throw new ApiError(400, "Registration number required");

    // Check existing NGO
    const existingNGO = await NGO.findOne({ $or: [{ email }, { regNumber }] });
    if (existingNGO) {
        throw new ApiError(
            409,
            existingNGO.email === email
                ? "Email already registered"
                : "Registration number already exists"
        );
    }

    // Upload and validate documents
    let documents = {};
    if (req.files) {
        const allowedDocs = [
            "registrationCert",
            "licenseCert",
            "taxExemptionCert",
        ];
        for (const docType of allowedDocs) {
            if (req.files[docType]) {
                documents[docType] = await uploadFile({
                    file: req.files[docType][0],
                    folder: `ngo-documents/${docType}`,
                });
            }
        }
    }

    const ngo = await NGO.create({
        name,
        email,
        password,
        contactPerson,
        address,
        regNumber,
        facilities,
        organizationType,
        operatingHours,
        documents,
        verificationStatus: "PENDING",
        registrationIP: req.ip,
        deviceInfo: req.headers["user-agent"],
    });

    // Log activity
    await Activity.create({
        type: "NGO_REGISTERED",
        performedBy: { userId: ngo._id, userModel: "NGO" },
        details: {
            ngoId: ngo._id,
            name: ngo.name,
            registrationIP: req.ip,
            timestamp: new Date(),
        },
    });

    return res.status(201).json(
        new ApiResponse(
            201,
            {
                ngo: {
                    _id: ngo._id,
                    name: ngo.name,
                    email: ngo.email,
                    status: ngo.verificationStatus,
                },
            },
            "NGO registration submitted for verification"
        )
    );
});

// Login
const loginNGO = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        throw new ApiError(400, "Email and password are required");

    const ngo = await NGO.findOne({ email });
    if (!ngo) throw new ApiError(404, "NGO not found");

    const isMatch = await ngo.comparePassword(password);
    if (!isMatch) throw new ApiError(401, "Invalid credentials");

    const tokens = await generateTokens(ngo._id);

    return res
        .status(200)
        .json(new ApiResponse(200, { ngo, ...tokens }, "Login successful"));
});

// Logout
const logoutNGO = asyncHandler(async (req, res) => {
    const ngoId = req.ngo._id;
    const ngo = await NGO.findById(ngoId);
    if (!ngo) throw new ApiError(404, "NGO not found");

    ngo.refreshToken = null;
    await ngo.save({ validateBeforeSave: false });

    return res.status(200).json(new ApiResponse(200, {}, "Logout successful"));
});

// Change Password
const changePassword = asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const ngoId = req.ngo._id;

    if (!oldPassword || !newPassword)
        throw new ApiError(400, "Old and new passwords are required");

    const ngo = await NGO.findById(ngoId);
    if (!ngo) throw new ApiError(404, "NGO not found");

    const isMatch = await ngo.comparePassword(oldPassword);
    if (!isMatch) throw new ApiError(401, "Old password is incorrect");

    ngo.password = newPassword;
    await ngo.save();

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Password updated successfully"));
});

// Profile Management
const getNGOProfile = asyncHandler(async (req, res) => {
    const ngo = await NGO.findById(req.ngo._id).select(
        "-password -refreshToken"
    );
    if (!ngo) throw new ApiError(404, "NGO not found");
    return res
        .status(200)
        .json(new ApiResponse(200, ngo, "NGO profile fetched successfully"));
});

// Update NGO Profile
const updateNGOProfile = asyncHandler(async (req, res) => {
    const ngoId = req.ngo._id;
    const updateFields = { ...req.body };

    // Handle document uploads
    if (req.files) {
        const allowedDocs = [
            "registrationCert",
            "licenseCert",
            "taxExemptionCert",
            "logo",
        ];
        for (const docType of allowedDocs) {
            if (req.files[docType]) {
                updateFields[`documents.${docType}`] = await uploadFile({
                    file: req.files[docType][0],
                    folder: `ngo-documents/${docType}`,
                });
            }
        }
    }

    const ngo = await NGO.findByIdAndUpdate(ngoId, updateFields, {
        new: true,
        runValidators: true,
    });
    if (!ngo) throw new ApiError(404, "NGO not found");

    return res
        .status(200)
        .json(new ApiResponse(200, ngo, "NGO profile updated successfully"));
});

// Facility Management
const manageFacility = asyncHandler(async (req, res) => {
    const { action } = req.params;
    const ngoId = req.ngo._id;

    if (req.ngo.status !== NGO_STATUS.ACTIVE) {
        throw new ApiError(403, "NGO must be active to manage facilities");
    }

    if (action === FACILITY_OPERATIONS.CREATE) {
        const facility = await Facility.create({
            ...req.body,
            ngoId,
            facilityType:
                req.body.type === "CAMP"
                    ? FACILITY_TYPE.CAMP
                    : FACILITY_TYPE.CENTER,
            status: req.body.type === "CAMP" ? "PLANNED" : "INACTIVE",
            location: {
                type: "Point",
                coordinates: [req.body.longitude, req.body.latitude],
            },
        });

        if (facility.facilityType === FACILITY_TYPE.CAMP) {
            await notifyNearbyDonors(facility);
        }

        return res
            .status(201)
            .json(
                new ApiResponse(201, facility, "Facility created successfully")
            );
    }

    if (action === FACILITY_OPERATIONS.LIST) {
        const facilities = await Facility.find({ ngoId });
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    facilities,
                    "Facilities fetched successfully"
                )
            );
    }

    const facility = await Facility.findOne({
        _id: req.params.facilityId,
        ngoId,
    });
    if (!facility) throw new ApiError(404, "Facility not found");

    switch (action) {
        case FACILITY_OPERATIONS.UPDATE:
            Object.assign(facility, req.body);
            await facility.save();
            break;
        case FACILITY_OPERATIONS.DELETE:
            await facility.deleteOne();
            break;
        case FACILITY_OPERATIONS.SUSPEND:
        case FACILITY_OPERATIONS.ACTIVATE:
            facility.status =
                action === FACILITY_OPERATIONS.SUSPEND ? "SUSPENDED" : "ACTIVE";
            await facility.save();
            break;
        default:
            throw new ApiError(400, "Invalid operation");
    }

    return res
        .status(200)
        .json(
            new ApiResponse(200, facility, `Facility ${action}d successfully`)
        );
});

// Blood Request Management
const handleBloodRequest = asyncHandler(async (req, res) => {
    const { requestId } = req.params;
    const { action, notes, assignedDonors } = req.body;
    const ngoId = req.ngo._id;

    const request = await BloodRequest.findOne({ _id: requestId }).populate(
        "hospitalId",
        "name address contactInfo"
    );
    if (!request) throw new ApiError(404, "Blood request not found");

    await request.updateStatus(action, ngoId, notes);

    // Handle different actions
    if (action === "ACCEPTED" && assignedDonors) {
        // Assign donors logic here if needed
    }
    // Add logic for COMPLETED, REJECTED, etc. as needed

    return res
        .status(200)
        .json(new ApiResponse(200, request, "Request handled successfully"));
});

// Blood Inventory Management
const updateBloodInventory = asyncHandler(async (req, res) => {
    // Implement inventory update logic here
    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Inventory updated (stub)"));
});

// Hospital Connections
const getConnectedHospitals = asyncHandler(async (req, res) => {
    // Implement logic to fetch connected hospitals
    return res
        .status(200)
        .json(new ApiResponse(200, [], "Connected hospitals fetched (stub)"));
});

// Respond to Hospital Connection Request
const respondToConnectionRequest = asyncHandler(async (req, res) => {
    // Implement logic to respond to hospital connection requests
    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Connection response handled (stub)"));
});

// Analytics & Reports
const getNGOAnalytics = asyncHandler(async (req, res) => {
    // Implement analytics logic here
    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Analytics fetched (stub)"));
});

// Helper: Notify nearby donors for new camp
const notifyNearbyDonors = async (facility) => {
    const nearbyUsers = await User.find({
        "address.location": {
            $near: {
                $geometry: facility.location,
                $maxDistance: 10000, // 10km radius
            },
        },
        donorStatus: "Active",
        notificationPreferences: {
            $elemMatch: { type: "CAMP_ANNOUNCEMENTS", enabled: true },
        },
    }).select("_id email phone");

    await notificationService.sendBulkNotifications(
        nearbyUsers,
        "NEW_FACILITY_ANNOUNCEMENT",
        {
            facilityId: facility._id,
            facilityName: facility.name,
            facilityType: facility.facilityType,
            startDate: facility.schedule?.startDate,
            location: facility.address,
        }
    );
};

// Resend Verification OTP
const resendVerificationOtp = asyncHandler(async (req, res) => {
    const ngoId = req.ngo._id;
    const ngo = await NGO.findById(ngoId);
    if (!ngo) throw new ApiError(404, "NGO not found");

    if (ngo.verificationStatus !== NGO_STATUS.PENDING) {
        throw new ApiError(400, "Verification already completed or not pending");
    }

    // Generate and send OTP
    const otp = await generateOtp();
    ngo.verificationOtp = otp;
    await ngo.save();

    await notificationService.sendNotification(ngo.email, "Verification OTP", `Your OTP is ${otp}`);

    return res.status(200).json(new ApiResponse(200, {}, "Verification OTP resent successfully"));
});

export {
    registerNGO,
    loginNGO,
    logoutNGO,
    changePassword,
    getNGOProfile,
    updateNGOProfile,
    manageFacility,
    handleBloodRequest,
    updateBloodInventory,
    getConnectedHospitals,
    respondToConnectionRequest,
    getNGOAnalytics,
    resendVerificationOtp,
};