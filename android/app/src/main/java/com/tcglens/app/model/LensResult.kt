package com.tcglens.app.model

data class LensResult(
    val name: String,
    val subtitle: String,
    val price: String? = null,
    val heat: Int? = null
)
