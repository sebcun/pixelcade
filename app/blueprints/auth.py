from flask import Blueprint

auth_bp = Blueprint("auth", __name__)


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    return "auth login placeholder"


@auth_bp.route("/signup", methods=["GET", "POST"])
def signup():
    return "auth signup placeholder"


@auth_bp.route("/logout", methods=["GET", "POST"])
def logout():
    return "auth logout placeholder"
