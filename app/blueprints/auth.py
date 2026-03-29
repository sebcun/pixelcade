import re
from typing import Optional

from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required, login_user, logout_user
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from app.extensions import bcrypt, db, limiter
from app.models import User

auth_bp = Blueprint("auth", __name__)
api_auth_bp = Blueprint("api_auth", __name__)

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,20}$")
EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")
PASSWORD_MIN_LEN = 8


def _signup_error(message: str, field: str):
    return jsonify({"error": message, "field": field}), 400


def _password_error_message(password: str) -> Optional[str]:
    if len(password) < PASSWORD_MIN_LEN:
        return f"Password must be at least {PASSWORD_MIN_LEN} characters"
    if not re.search(r"[A-Za-z]", password):
        return "Password must include at least one letter"
    if not re.search(r"\d", password):
        return "Password must include at least one number"
    return None


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    return "auth login placeholder"


@auth_bp.route("/signup", methods=["GET", "POST"])
def signup():
    return "auth signup placeholder"


@auth_bp.route("/logout", methods=["GET", "POST"])
def logout():
    return "auth logout placeholder"


@api_auth_bp.route("/signup", methods=["POST"])
@limiter.limit("10/hour")
def api_signup():
    if not request.is_json:
        return _signup_error("Request body must be JSON", "body")

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _signup_error("Invalid JSON", "body")

    required = (
        "username",
        "email",
        "password",
        "confirm_password",
        "accept_tos",
        "accept_privacy",
    )
    for key in required:
        if key not in data:
            return _signup_error("This field is required", key)
        if data[key] is None:
            return _signup_error("This field is required", key)

    username = data["username"]
    email = data["email"]
    password = data["password"]
    confirm_password = data["confirm_password"]
    accept_tos = data["accept_tos"]
    accept_privacy = data["accept_privacy"]

    if not isinstance(username, str):
        return _signup_error("username must be a string", "username")
    if not isinstance(email, str):
        return _signup_error("email must be a string", "email")
    if not isinstance(password, str):
        return _signup_error("password must be a string", "password")
    if not isinstance(confirm_password, str):
        return _signup_error("confirm_password must be a string", "confirm_password")
    if not isinstance(accept_tos, bool):
        return _signup_error("accept_tos must be a boolean", "accept_tos")
    if not isinstance(accept_privacy, bool):
        return _signup_error("accept_privacy must be a boolean", "accept_privacy")

    if not accept_tos:
        return _signup_error("You must accept the Terms of Service", "accept_tos")
    if not accept_privacy:
        return _signup_error("You must accept the Privacy Policy", "accept_privacy")

    if password != confirm_password:
        return _signup_error("Passwords do not match", "confirm_password")

    pwd_msg = _password_error_message(password)
    if pwd_msg:
        return _signup_error(pwd_msg, "password")

    username_clean = username.strip()
    if not USERNAME_RE.match(username_clean):
        return _signup_error(
            "Username must be 3–20 characters and use only letters, numbers, and underscores",
            "username",
        )

    username_stored = username_clean.lower()

    email_norm = email.strip().lower()
    if not email_norm or not EMAIL_RE.match(email_norm):
        return _signup_error("Invalid email address", "email")

    if User.query.filter(func.lower(User.username) == username_stored).first():
        return _signup_error("Username is already taken", "username")
    if User.query.filter(func.lower(User.email) == email_norm).first():
        return _signup_error("Email is already registered", "email")

    raw_hash = bcrypt.generate_password_hash(password, rounds=12)
    password_hash = raw_hash.decode("utf-8") if isinstance(raw_hash, bytes) else raw_hash
    user = User(username=username_stored, email=email_norm, password_hash=password_hash)
    db.session.add(user)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        if User.query.filter(func.lower(User.username) == username_stored).first():
            return _signup_error("Username is already taken", "username")
        if User.query.filter(func.lower(User.email) == email_norm).first():
            return _signup_error("Email is already registered", "email")
        raise

    login_user(user)
    return (
        jsonify(
            {
                "message": "Account created",
                "user": {"id": user.id, "username": user.username},
            }
        ),
        201,
    )


def _login_bad_request():
    return jsonify({"error": "Invalid request"}), 400


@api_auth_bp.route("/login", methods=["POST"])
@limiter.limit("5/15 minutes")
def api_login():
    if not request.is_json:
        return _login_bad_request()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _login_bad_request()

    email = data.get("email")
    password = data.get("password")
    if email is None or password is None:
        return _login_bad_request()
    if not isinstance(email, str) or not isinstance(password, str):
        return _login_bad_request()

    email_norm = email.strip().lower()
    user = User.query.filter(func.lower(User.email) == email_norm).first()
    if user is None or not bcrypt.check_password_hash(user.password_hash, password):
        return jsonify({"error": "Invalid email or password"}), 401

    login_user(user)
    return (
        jsonify(
            {
                "message": "Logged in",
                "user": {"id": user.id, "username": user.username},
            }
        ),
        200,
    )


@api_auth_bp.route("/logout", methods=["POST"])
@login_required
def api_logout():
    logout_user()
    return jsonify({"message": "Logged out"}), 200


@api_auth_bp.route("/me", methods=["GET"])
def api_me():
    if not current_user.is_authenticated:
        return jsonify({"error": "Not authenticated"}), 401

    raw_avatar = current_user.avatar
    avatar = raw_avatar if isinstance(raw_avatar, dict) else {}

    return (
        jsonify(
            {
                "id": current_user.id,
                "username": current_user.username,
                "email": current_user.email,
                "level": current_user.level,
                "xp": current_user.xp,
                "pixels": current_user.pixels,
                "avatar": avatar,
                "created_at": current_user.created_at.isoformat() + "Z"
                if current_user.created_at
                else None,
            }
        ),
        200,
    )
