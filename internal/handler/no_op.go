package handler

import (
	"context"

	"github.com/hibiken/asynq"
)

const TaskTypeNoOp = "no_op"

func HandleNoOp(ctx context.Context, t *asynq.Task) error {
	return nil
}
