from flask import Blueprint

avatar_bp = Blueprint("avatar", __name__)


@avatar_bp.route("/")
def customize():
    return "avatar customization placeholder"
