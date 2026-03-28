from flask import Blueprint

profile_bp = Blueprint("profile", __name__)


@profile_bp.route("/")
def me():
    return "profile self placeholder"


@profile_bp.route("/<user_id>")
def user(user_id: str):
    return "profile user placeholder"
